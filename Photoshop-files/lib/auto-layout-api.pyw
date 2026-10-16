import os
import sys
import socket
import json
import time
import threading
import tempfile
import re
import logging
import math
import itertools
import urllib.request
from functools import lru_cache
from importlib import resources
from logging.handlers import RotatingFileHandler
from concurrent.futures import ThreadPoolExecutor

def prepare_install():
    """Stop only a verified Auto Layout server, before changing its environment."""
    probe = socket.socket()
    probe.settimeout(0.5)
    try:
        if probe.connect_ex(("127.0.0.1", 6341)) != 0:
            return 0
        probe.sendall(b'{"type":"heartbeat","target_id":"__install_probe__"}\n')
    finally:
        probe.close()
    request_id = "installer-" + str(time.time_ns())
    try:
        with socket.socket() as listener:
            listener.settimeout(5)
            # A Photoshop request owns this callback port while analyzing. Do not
            # interrupt it or change packages under its active interpreter.
            listener.bind(("127.0.0.1", 6340))
            listener.listen(1)
            with socket.create_connection(("127.0.0.1", 6341), timeout=2) as sender:
                sender.sendall((json.dumps(dict(type="handshake", request_id=request_id)) + "\n").encode("ascii"))
            with listener.accept()[0] as client:
                client.settimeout(5)
                data = b""
                while b"\n" not in data and len(data) < 65536:
                    block = client.recv(4096)
                    if not block:
                        break
                    data += block
                response = json.loads(data)
        server_id = response.get("server_id", "")
        if (response.get("request_id") != request_id or response.get("type") != "answer" or
                not server_id.startswith("auto-layout/") or response.get("message") != server_id):
            raise RuntimeError("port 6341 belongs to an unverified application")
        with socket.create_connection(("127.0.0.1", 6341), timeout=2) as sender:
            sender.sendall(b'{"type":"shutdown"}\n')
            with sender.makefile("r", encoding="ascii") as stream:
                stopped = json.loads(stream.readline(65536))
            if stopped.get("stopped") is not True or stopped.get("server_id") != server_id:
                raise RuntimeError("server shutdown was not acknowledged")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            with socket.socket() as probe:
                probe.settimeout(0.25)
                if probe.connect_ex(("127.0.0.1", 6341)) != 0:
                    print("Previous Auto Layout server stopped.")
                    return 0
                probe.sendall(b'{"type":"heartbeat","target_id":"__install_probe__"}\n')
            time.sleep(0.1)
        raise RuntimeError("server did not stop within 20 seconds")
    except (OSError, ValueError, RuntimeError) as exc:
        print("Cannot prepare runtime update:", exc)
        print("Finish any Photoshop analysis, then retry. An unverified process is never stopped.")
        return 1


if __name__ == "__main__" and "--prepare-install" in sys.argv:
    raise SystemExit(prepare_install())


import cv2
import numpy as np
import pymorphy3

API_HOST = "127.0.0.1"
API_PORT_SEND = 6340      # Python -> JSX response listener
API_PORT_LISTEN = 6341    # JSX -> Python requests
SERVER_ID = "auto-layout/0.10.42"
TIMEOUT = 15 * 60
REQUEST_HEARTBEAT_TIMEOUT = 4.0
COMPOSITION_MAX_SCALE_LOSS = 0.01

NAME_CONFIDENCE = 0.94
IMAGE_CONFIDENCE = 0.76
FACE_CONFIDENCE = 0.72
MULTI_FACE_AREA_RATIO = 0.55

last_request_time = time.monotonic()
request_lock = threading.Lock()
active_requests = {}
active_requests_lock = threading.Lock()
pending_cleanup = set()
cleanup_lock = threading.Lock()
shutdown_event = threading.Event()

morph = None
morph_lock = threading.Lock()
russian_names_lock = threading.RLock()
russian_names_store = None
russian_names_attempted = False
face_detector = None
face_detector_lock = threading.Lock()
gender_net = None
gender_net_lock = threading.Lock()
body_landmarker = None
body_landmarker_lock = threading.Lock()
head_landmarker = None
head_landmarker_lock = threading.Lock()
model_init_lock = threading.Lock()
analysis_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="auto-layout-pose")

CYRILLIC_RE = re.compile(r"[А-ЯЁа-яё][А-ЯЁа-яё-]{1,}")


def resolve_model_path(filename):
    return os.path.join(sys.prefix, "models", filename)


FACE_MODEL_PATH = resolve_model_path("face.onnx")
GENDER_MODEL_PATH = resolve_model_path("gender.onnx")
HEAD_MODEL_PATH = resolve_model_path("face_landmarker.task")
BODY_MODEL_PATH = resolve_model_path("pose_landmarker_full.task")
HEAD_FRONT_DEGREES = 2.0
# Body yaw around the old 12-degree cutoff is intentionally blended instead
# of switched. 8..16 keeps 12 degrees at the middle of a smooth transition.
BODY_TURN_BLEND_START_DEGREES = 6.0
BODY_TURN_BLEND_FULL_DEGREES = 18.0
BODY_BASE_WEIGHT = 0.70


def get_morph():
    global morph
    if morph is not None:
        return morph
    with morph_lock:
        if morph is None:
            morph = pymorphy3.MorphAnalyzer(lang="ru")
    return morph


def get_russian_names():
    global russian_names_store, russian_names_attempted
    with russian_names_lock:
        if russian_names_attempted:
            return russian_names_store
        russian_names_attempted = True
        try:
            from russiannames.datastore import NamesDatastore
            # Explicit bundled path: no environment override, remote DB or URL.
            directory = str(resources.files("russiannames").joinpath("data"))
            for name in ("names", "surnames", "midnames"):
                if not os.path.isfile(os.path.join(directory, name + ".parquet")):
                    raise FileNotFoundError("Bundled russiannames dataset missing: " + name)
            store = NamesDatastore(data_dir=directory)
            try:
                if not store.find_one("names", "Иван"):
                    raise RuntimeError("russiannames dictionary self-check failed")
            except Exception:
                store.close()
                raise
            russian_names_store = store
        except Exception:
            # Existing runtime can still use pymorphy3 until its installer runs.
            logging.warning("russiannames unavailable; using pymorphy3 fallback", exc_info=True)
        return russian_names_store


@lru_cache(maxsize=4096)
def russian_name_record(dataset, token):
    with russian_names_lock:
        store = get_russian_names()
        if store is None:
            return None
        text = token.title()
        result = store.find_one(dataset, text)
        if result is None and "ё" in text.casefold():
            result = store.find_one(dataset, text.replace("ё", "е").replace("Ё", "Е"))
        return result


ALPHABET_WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё]+(?:[-‐‑][A-Za-zА-Яа-яЁё]+)*")
ALPHABET_SERVICE_WORDS = frozenset("слой группа копия копировать дубль вариант фото фотография портрет кадр рамка фон новый новая обработка обработано учитель учительница ученик ученица мальчик девочка layer group copy duplicate version photo image img dsc dscn background edited final psd jpg jpeg png tif tiff raw cr crw nef arw".split())


@lru_cache(maxsize=4096)
def alphabetical_token_roles(token):
    """Identity roles only; original spelling is used for the final key."""
    name = russian_name_record("names", token)
    surname = russian_name_record("surnames", token)
    middle = russian_name_record("midnames", token)
    nf = float(name.get('count', 0)) if name else 0.0
    sf = float(surname.get('count', 0)) if surname else 0.0
    mf = float(middle.get('count', 0)) if middle else 0.0
    # Rare surname-as-name records (e.g. Иванов) must not reverse the identity.
    given_score = 100.0 if name and nf >= max(sf, mf) else 0.0
    surname_score = 100.0 if surname and sf >= max(nf, mf) else 0.0
    if not name:
        candidate = parse_candidate(token, "Name")
        if candidate and candidate["score"] >= .1:
            given_score = candidate["score"] * 10
    if not surname:
        candidate = parse_candidate(token, "Surn")
        if candidate and candidate["nominative"] and candidate["score"] >= .1:
            surname_score = candidate["score"] * 10
    return given_score, surname_score, bool(middle)


def alphabetical_name_key(layer_name):
    # Discard embedded asset IDs, e.g. IMG_0023/DSC1234, and numeric indices.
    text = re.sub(r"[A-Za-z]+[_-]?\d+", " ", str(layer_name or ""))
    tokens = [word for word in ALPHABET_WORD_RE.findall(text)
              if word.casefold() not in ALPHABET_SERVICE_WORDS][:64]
    if not tokens:
        return dict(key="", named=False, identity="", method="empty")
    roles = [alphabetical_token_roles(token) if re.search(r"[А-Яа-яЁё]", token) else (0, 0, False)
             for token in tokens]
    pairs = []
    for ni, (ns, _, _) in enumerate(roles):
        if ns <= 0:
            continue
        for si, (_, ss, _) in enumerate(roles):
            if ni == si or ss <= 0 or abs(ni - si) > 2:
                continue
            pairs.append((ns + ss - abs(ni - si), -min(ni, si), si, ni))
    if pairs:
        _, _, si, ni = max(pairs)
        identity = " ".join(tokens[i] for i in sorted((si, ni)))
        method = "written_pair"
    else:
        names = [(score, -i, i) for i, (score, _, _) in enumerate(roles) if score > 0]
        if names:
            _, _, ni = max(names)
            # A rare surname can be absent from both dictionaries. Prefer the
            # adjacent non-patronymic word, conventionally preceding the name.
            adjacent = [i for i in (ni - 1, ni + 1) if 0 <= i < len(tokens) and not roles[i][2]]
            identity = " ".join(tokens[i] for i in sorted((adjacent[0], ni))) if adjacent else tokens[ni]
            method = "given_adjacent"
        else:
            identity = " ".join(tokens[:2])
            method = "cleaned_literal"
    key = identity.casefold().replace("ё", "е").replace("‐", "-").replace("‑", "-")
    return dict(key=key, named=True, identity=identity, method=method)


def classify_name_dictionary(layer_name):
    if get_russian_names() is None:
        return None
    tokens = CYRILLIC_RE.findall(str(layer_name or ""))
    if not tokens or len(tokens) > 64:
        return None
    names, surnames, middles = [], [], []
    for index, token in enumerate(tokens):
        fn = russian_name_record("names", token)
        sn = russian_name_record("surnames", token)
        mn = russian_name_record("midnames", token)
        if sn:
            surnames.append((index, token, sn))
        if mn:
            middles.append((index, token, mn))
        # Records may contain rare surname/patronymic-as-first-name entries.
        # Preserve the more frequent explicit role in a multiword identity.
        frequency = float(fn.get("count", 0)) if fn else 0
        other = max(float(r.get("count", 0)) for r in (sn or {}, mn or {}))
        if fn and (frequency >= other or other == 0):
            names.append((index, token, fn))
    if not names:
        return None
    if len(names) != 1:
        return dict(sex="U", confidence=0.0, source="unknown", reason="dictionary_multiple_given_names",
                    needs_image=True, analysis_status="needs_image", name_engine="russiannames")
    index, token, record = names[0]
    gender = "u" if token.casefold() in ("саша", "женя", "валя", "шура") else record.get("gender")
    middle = [(i, t, r) for i, t, r in middles if i != index and abs(i - index) <= 2 and r.get("gender") in ("m", "f")]
    surname = [(i, t, r) for i, t, r in surnames if i != index and abs(i - index) <= 2 and r.get("gender") in ("m", "f")]
    signals = {r["gender"] for i, t, r in middle + surname}
    if gender in ("m", "f"):
        signals.add(gender)
    elif gender == "u" and len(signals) == 1:
        gender = next(iter(signals))
    if len(signals) > 1 or gender not in ("m", "f"):
        return dict(sex="U", confidence=0.0, source="unknown", reason="dictionary_gender_conflict" if len(signals) > 1 else "dictionary_gender_ambiguous",
                    needs_image=True, analysis_status="needs_image", name_engine="russiannames")
    return dict(sex="M" if gender == "m" else "F", confidence=.98 if signals and (middle or surname) else .94,
                source="name", reason="name_dictionary", needs_image=False, analysis_status="ok",
                name_engine="russiannames", matched_name=token,
                matched_surname=surname[0][1] if surname else "",
                matched_patronymic=middle[0][1] if middle else "")


def classify_name(layer_name):
    global russian_names_store
    try:
        result = classify_name_dictionary(layer_name)
    except Exception:
        logging.exception("russiannames query failed; disabling it for this server run")
        with russian_names_lock:
            if russian_names_store is not None:
                try:
                    russian_names_store.close()
                except Exception:
                    pass
                russian_names_store = None
            russian_name_record.cache_clear()
        result = None
    if result is not None:
        return result
    result = classify_name_morph(layer_name)
    result["name_engine"] = "pymorphy3"
    return result


def parse_candidate(token, grammeme, gender_filter=None):
    # Layer identities are nominative. "Амина" can otherwise be interpreted
    # as the genitive of the masculine name "Амин" by the dictionary.
    if grammeme == "Name" and token.casefold() == "амина":
        if gender_filter and gender_filter != "femn":
            return None
        return dict(token=token, score=1.0, gender="femn", normal="амина", nominative=True)
    best = None
    for parsed in get_morph().parse(token):
        if grammeme not in parsed.tag:
            continue
        if grammeme == "Name" and "nomn" not in parsed.tag:
            continue
        gender = parsed.tag.gender
        if gender not in ("masc", "femn"):
            gender = None
        if gender_filter and gender not in (gender_filter, None):
            continue
        candidate = {
            "token": token,
            "score": float(parsed.score),
            "gender": gender,
            "normal": parsed.normal_form,
            "nominative": "nomn" in parsed.tag,
        }
        if best is None or (candidate["nominative"], candidate["score"]) > (best["nominative"], best["score"]):
            best = candidate
    return best


def surname_shape_candidate(token):
    """Restricted backup for dictionary omissions, confirmed by a strong given name."""
    if not token or not token[0].isupper():
        return None
    parsed = get_morph().parse(token)
    if any(("Name" in p.tag or "Patr" in p.tag) and "nomn" in p.tag for p in parsed):
        return None
    value = token.casefold()
    gender = ("femn" if re.search(r"(?:ова|ева|ёва|ина|ына|ская|цкая)$", value) else
              "masc" if re.search(r"(?:ов|ев|ёв|ин|ын|ский|цкий)$", value) else None)
    if gender is None:
        return None
    return dict(token=token, score=.5, gender=gender, normal=value, nominative=True, shape_only=True)


def classify_name_morph(layer_name):
    """Use a reliable Cyrillic Name+Surname pair only; annotations are ignored."""
    if not isinstance(layer_name, str):
        layer_name = "" if layer_name is None else str(layer_name)

    tokens = CYRILLIC_RE.findall(layer_name)
    if len(tokens) < 2:
        return {
            "sex": "U", "confidence": 0.0, "source": "unknown",
            "reason": "no_name_pair", "needs_image": True, "analysis_status": "needs_image",
        }

    name_candidates = []
    surname_candidates = []
    for index, token in enumerate(tokens):
        n = parse_candidate(token, "Name")
        if n:
            n["index"] = index
            name_candidates.append(n)
        s = parse_candidate(token, "Surn") or surname_shape_candidate(token)
        if s:
            s["index"] = index
            surname_candidates.append(s)

    best_pair = None
    pairs = []
    for n in name_candidates:
        for s in surname_candidates:
            if n["index"] == s["index"]:
                continue
            if s.get("shape_only") and (n["score"] < .8 or not n["gender"]):
                continue
            if n["gender"] and s["gender"] and n["gender"] != s["gender"]:
                compatible = parse_candidate(s["token"], "Surn", n["gender"])
                if compatible and (not s["nominative"] or compatible["nominative"]):
                    compatible["index"] = s["index"]
                    s = compatible
            # The first name is the primary gender signal. A gendered surname may
            # confirm it; a contradiction makes this pair unsafe and forces image fallback.
            if n["gender"] and s["gender"] and n["gender"] != s["gender"]:
                continue
            gender = n["gender"] or s["gender"]
            if gender not in ("masc", "femn"):
                continue
            distance = abs(n["index"] - s["index"])
            # In real layer names the child's surname and first name are adjacent
            # (or have at most one Cyrillic annotation between them). Refuse more
            # distant pairs so arbitrary retoucher notes cannot accidentally form
            # a synthetic identity.
            if distance > 2:
                continue
            adjacency = 0.12 if distance == 1 else 0.04
            agreement = 0.12 if n["gender"] and s["gender"] and n["gender"] == s["gender"] else 0.0
            score = 0.68 * n["score"] + 0.32 * s["score"] + adjacency + agreement
            pair = (score, n, s, gender)
            pairs.append(pair)
            if best_pair is None or pair[0] > best_pair[0]:
                best_pair = pair

    if best_pair is None:
        return {
            "sex": "U", "confidence": 0.0, "source": "unknown",
            "reason": "no_reliable_name_pair", "needs_image": True, "analysis_status": "needs_image",
        }

    if any(pair[3] != best_pair[3] and pair[1]["score"] >= .8 and pair[2]["nominative"] and pair[1]["gender"] == pair[2]["gender"] for pair in pairs):
        return dict(sex="U", confidence=0.0, source="unknown", reason="conflicting_name_pairs",
                    needs_image=True, analysis_status="needs_image")

    _, n, s, gender = best_pair
    confidence = NAME_CONFIDENCE
    if n["gender"] and s["gender"] and n["gender"] == s["gender"] and not s.get("shape_only"):
        confidence = 0.98

    return {
        "sex": "M" if gender == "masc" else "F",
        "confidence": confidence,
        "source": "name",
        "reason": "name_surname_shape" if s.get("shape_only") else "name_surname",
        "needs_image": False,
        "analysis_status": "ok",
        "matched_name": n["token"],
        "matched_surname": s["token"],
    }


def get_face_detector():
    global face_detector
    if face_detector is not None:
        return face_detector
    with face_detector_lock:
        if face_detector is None:
            if not os.path.isfile(FACE_MODEL_PATH):
                raise RuntimeError("face.onnx is missing; run install_runtime.bat")
            face_detector = cv2.FaceDetectorYN.create(
                FACE_MODEL_PATH, "", (320, 320), FACE_CONFIDENCE, 0.3, 5000
            )
    return face_detector


def get_gender_net():
    global gender_net
    if gender_net is not None:
        return gender_net
    with gender_net_lock:
        if gender_net is None:
            if not os.path.isfile(GENDER_MODEL_PATH):
                raise RuntimeError("gender.onnx is missing; run install_runtime.bat")
            gender_net = cv2.dnn.readNetFromONNX(GENDER_MODEL_PATH)
            gender_net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            gender_net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
    return gender_net


def read_image(path):
    if not isinstance(path, str) or not os.path.isfile(path):
        return None
    try:
        return cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        return None


def choose_face(img, with_region=False):
    h, w = img.shape[:2]
    if h < 16 or w < 16:
        return None, "image_too_small"

    detector = get_face_detector()
    with face_detector_lock:
        detector.setInputSize((w, h))
        _, faces = detector.detect(img)

    if faces is None or len(faces) == 0:
        return None, "face_not_found"

    valid = []
    for face in faces:
        score = float(face[-1])
        if score < FACE_CONFIDENCE:
            continue
        x, y, fw, fh = [float(v) for v in face[:4]]
        if not all(math.isfinite(v) for v in (score, x, y, fw, fh)) or fw <= 8 or fh <= 8:
            continue
        valid.append((fw * fh, score, x, y, fw, fh))

    if not valid:
        return None, "face_low_confidence"

    valid.sort(key=lambda v: (v[0], v[1]), reverse=True)
    best = valid[0]
    if len(valid) > 1 and valid[1][0] >= best[0] * MULTI_FACE_AREA_RATIO:
        return None, "multiple_faces"

    _, face_score, x, y, fw, fh = best
    side = max(fw, fh) * 1.45
    cx = x + fw * 0.5
    cy = y + fh * 0.5
    # Slight upward bias keeps hair/forehead while still including chin.
    cy -= side * 0.035

    x0 = max(0, int(round(cx - side * 0.5)))
    y0 = max(0, int(round(cy - side * 0.5)))
    x1 = min(w, int(round(cx + side * 0.5)))
    y1 = min(h, int(round(cy + side * 0.5)))
    if x1 - x0 < 16 or y1 - y0 < 16:
        return None, "face_crop_too_small"

    selected = (img[y0:y1, x0:x1], face_score)
    if with_region:
        selected += ((x0, y0, x1, y1),)
    return selected, None


def binary_probabilities(values):
    """Accept either model probabilities or logits and normalize conservatively."""
    values = np.asarray(values, dtype=np.float64).reshape(-1)
    if values.size != 2 or not np.all(np.isfinite(values)):
        return None
    values = values[:2]
    total = float(np.sum(values))
    # The ONNX model may expose its final Softmax output. Do not Softmax an
    # already normalized [Male, Female] vector because that would artificially
    # destroy confidence (e.g. 0.95/0.05 -> 0.71/0.29).
    if np.all(values >= 0.0) and np.all(values <= 1.0) and abs(total - 1.0) <= 0.02:
        return values / total if total > 0 else None
    m = float(np.max(values))
    e = np.exp(values - m)
    total = float(np.sum(e))
    if not np.isfinite(total) or total <= 0:
        return None
    return e / total


def classify_gender_crop(face_crop, face_score, cancel_check=None):
    # Follow the ONNX Model Zoo reference preprocessing for GoogleNet:
    # convert the OpenCV BGR crop to RGB, resize to 224x224 and subtract
    # the published 104/117/123 channel means.
    face_rgb = cv2.cvtColor(face_crop, cv2.COLOR_BGR2RGB)
    blob = cv2.dnn.blobFromImage(
        face_rgb, scalefactor=1.0, size=(224, 224),
        mean=(104.0, 117.0, 123.0), swapRB=False, crop=False
    )

    if min(face_crop.shape[:2]) < 48 or not math.isfinite(face_score) or face_score < .80:
        return dict(sex="U", confidence=0.0, source="unknown", reason="gender_face_unreliable",
                    needs_image=False, analysis_status="uncertain", face_confidence=float(face_score))
    net = get_gender_net()
    mirror_blob = cv2.dnn.blobFromImage(cv2.flip(face_rgb, 1), 1.0, (224, 224),
                                       (104.0, 117.0, 123.0), swapRB=False, crop=False)
    with gender_net_lock:
        net.setInput(blob)
        first = binary_probabilities(net.forward())
        if cancel_check and cancel_check():
            return dict(sex="U", confidence=0.0, source="unknown", reason="gender_cancelled", needs_image=False, analysis_status="uncertain")
        net.setInput(mirror_blob)
        second = binary_probabilities(net.forward())
    if first is None or second is None:
        return dict(sex="U", confidence=0.0, source="unknown", reason="classifier_output_invalid",
                    needs_image=False, analysis_status="technical_failure")
    difference = float(np.max(np.abs(first - second)))
    if int(np.argmax(first)) != int(np.argmax(second)) or difference > .20:
        return dict(sex="U", confidence=float(min(np.max(first), np.max(second))), source="unknown",
                    reason="gender_mirror_disagreement", needs_image=False, analysis_status="uncertain",
                    face_confidence=float(face_score), mirror_difference=difference)
    probs = (first + second) / 2
    index = int(np.argmax(probs))
    confidence = float(min(first[index], second[index]))
    if confidence < IMAGE_CONFIDENCE:
        return {
            "sex": "U", "confidence": confidence, "source": "unknown",
            "reason": "classifier_low_confidence", "needs_image": False,
            "analysis_status": "uncertain",
            "face_confidence": float(face_score),
        }

    return {
        "sex": "M" if index == 0 else "F",
        "confidence": confidence,
        "source": "image",
        "reason": "face_classifier_mirror_checked",
        "mirror_difference": difference,
        "needs_image": False,
        "analysis_status": "ok",
        "face_confidence": float(face_score),
    }


def get_head_landmarker():
    global head_landmarker
    if head_landmarker is not None:
        return head_landmarker
    with head_landmarker_lock:
        if head_landmarker is None:
            import mediapipe as mp
            if not os.path.isfile(HEAD_MODEL_PATH):
                raise RuntimeError("face_landmarker.task is missing; update with install_runtime.bat")
            options = mp.tasks.vision.FaceLandmarkerOptions(
                base_options=mp.tasks.BaseOptions(model_asset_path=HEAD_MODEL_PATH),
                running_mode=mp.tasks.vision.RunningMode.IMAGE,
                num_faces=1,
                min_face_detection_confidence=0.6,
                min_face_presence_confidence=0.6,
                output_face_blendshapes=False,
                output_facial_transformation_matrixes=True,
            )
            with model_init_lock:
                head_landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(options)
    return head_landmarker


def pose_from_matrix(matrix):
    """Euler yaw from canonical->camera rotation, +yaw faces image RIGHT.

    Remove uniform scale with SVD; use Rz*Ry*Rx decomposition so roll/pitch do
    not masquerade as yaw. A front-facing canonical face has its +Z normal
    toward the camera in MediaPipe's right-handed metric space.
    """
    matrix = np.asarray(matrix, dtype=np.float64)
    if matrix.shape != (4, 4) or not np.all(np.isfinite(matrix)):
        raise ValueError("invalid face transformation matrix")
    linear = matrix[:3, :3]
    u, scales, vt = np.linalg.svd(linear)
    if scales[-1] <= 1e-8 or scales[0] / scales[-1] > 1.2 or np.linalg.det(linear) <= 0:
        raise ValueError("invalid face rotation/scale")
    rotation = u @ vt
    if np.linalg.det(rotation) < 0:
        raise ValueError("reflected face rotation")
    yaw = math.degrees(math.atan2(-rotation[2, 0], math.hypot(rotation[0, 0], rotation[1, 0])))
    pitch = math.degrees(math.atan2(rotation[2, 1], rotation[2, 2]))
    roll = math.degrees(math.atan2(rotation[1, 0], rotation[0, 0]))
    return yaw, pitch, roll


def head_result(status, reason, **values):
    return dict(analysis_status=status, reason=reason, method="face_transform", **values)


def classify_head_once(face_crop):
    if min(face_crop.shape[:2]) < 48:
        return head_result("uncertain", "head_crop_too_small")
    import mediapipe as mp
    landmarker = get_head_landmarker()
    rgb = cv2.cvtColor(face_crop, cv2.COLOR_BGR2RGB)
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
    with head_landmarker_lock:
        result = landmarker.detect(image)
    if len(result.face_landmarks) != 1 or len(result.facial_transformation_matrixes) != 1:
        return head_result("uncertain", "head_landmarks_not_found")
    points = result.face_landmarks[0]
    if len(points) < 468 or not all(math.isfinite(p.x) and math.isfinite(p.y) and math.isfinite(p.z) for p in points):
        return head_result("technical_failure", "head_landmarks_invalid")
    key_points = [points[i] for i in (1, 33, 263, 61, 291, 152)]
    if any(not (-.02 <= p.x <= 1.02 and -.02 <= p.y <= 1.02) for p in key_points):
        return head_result("uncertain", "head_landmarks_truncated")
    eye_distance = math.hypot((points[33].x - points[263].x) * face_crop.shape[1],
                             (points[33].y - points[263].y) * face_crop.shape[0])
    if eye_distance < 18:
        return head_result("uncertain", "head_landmarks_too_small")
    try:
        yaw, pitch, roll = pose_from_matrix(result.facial_transformation_matrixes[0])
    except (ValueError, np.linalg.LinAlgError):
        return head_result("technical_failure", "head_matrix_invalid")
    values = dict(yaw_degrees=yaw, pitch_degrees=pitch, roll_degrees=roll)
    if abs(yaw) > 80 or abs(pitch) > 45 or abs(roll) > 45:
        return head_result("uncertain", "head_pose_extreme", **values)
    # Small turns are neutral: prevent unstable left/right ordering near zero.
    signed = 0.0 if abs(yaw) < HEAD_FRONT_DEGREES else yaw
    return head_result("ok", "head_pose", turn=signed, **values)


def classify_head_crop(face_crop, cancel_check=None):
    first = classify_head_once(face_crop)
    if first.get("analysis_status") != "ok":
        return first
    if cancel_check and cancel_check():
        return head_result("uncertain", "head_cancelled")
    second = classify_head_once(cv2.flip(face_crop, 1))
    if second.get("analysis_status") != "ok":
        return head_result("uncertain", "head_mirror_unreliable")
    a, b = first["yaw_degrees"], -second["yaw_degrees"]
    if (a * b < 0 and min(abs(a), abs(b)) >= 4) or abs(a - b) > 12 or abs(first["pitch_degrees"] - second["pitch_degrees"]) > 15 or abs(first["roll_degrees"] + second["roll_degrees"]) > 15:
        return head_result("uncertain", "head_mirror_disagreement",
                           head_original_yaw_degrees=a, head_mirrored_yaw_degrees=b, head_mirror_difference=abs(a - b))
    yaw = (a + b) / 2
    return head_result("ok", "head_pose_mirror_checked", turn=0.0 if abs(yaw) < HEAD_FRONT_DEGREES else yaw,
                       yaw_degrees=yaw, pitch_degrees=(first["pitch_degrees"] + second["pitch_degrees"]) / 2,
                       roll_degrees=(first["roll_degrees"] - second["roll_degrees"]) / 2,
                       head_mirror_difference=abs(a - b))


def get_body_landmarker():
    global body_landmarker
    if body_landmarker is not None:
        return body_landmarker
    with body_landmarker_lock:
        if body_landmarker is None:
            import mediapipe as mp
            options = mp.tasks.vision.PoseLandmarkerOptions(
                base_options=mp.tasks.BaseOptions(model_asset_path=BODY_MODEL_PATH),
                running_mode=mp.tasks.vision.RunningMode.IMAGE, num_poses=2,
                min_pose_detection_confidence=0.6, min_pose_presence_confidence=0.6,
                output_segmentation_masks=False,
            )
            with model_init_lock:
                body_landmarker = mp.tasks.vision.PoseLandmarker.create_from_options(options)
    return body_landmarker


def body_yaw_from_shoulders(right, left):
    """World landmarks: anatomical right shoulder 12 -> left shoulder 11.

    Depth increases away from the camera. Positive left-minus-right depth
    implies the chest faces image-right. Remove in-plane shoulder tilt from the
    projected baseline rather than interpreting that tilt as a turn.
    """
    values = np.asarray([[right.x, right.y, right.z], [left.x, left.y, left.z]], dtype=np.float64)
    if not np.all(np.isfinite(values)):
        raise ValueError("invalid shoulder coordinates")
    dx, dy, dz = values[1] - values[0]
    span = math.sqrt(dx * dx + dy * dy + dz * dz)
    if not 0.12 <= span <= 0.8 or dx <= 0.025 or abs(dy) > abs(dx) * 0.8:
        raise ValueError("shoulder geometry is ambiguous")
    yaw = math.degrees(math.atan2(dz, math.hypot(dx, dy)))
    if abs(yaw) > 75:
        raise ValueError("body pose is extreme")
    return yaw


def classify_body_once(img, face_region=None):
    if not os.path.isfile(BODY_MODEL_PATH):
        return dict(analysis_status="unavailable", reason="body_model_missing")
    import mediapipe as mp
    # Full layer preview (not the face crop) is needed to see shoulders. The
    # image has already been read; this never reads or saves a second JPEG.
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    landmarker = get_body_landmarker()
    with body_landmarker_lock:
        result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
    candidates = []
    height, width = img.shape[:2]
    for index, landmarks in enumerate(result.pose_landmarks):
        if len(landmarks) < 13 or index >= len(result.pose_world_landmarks):
            continue
        nose = landmarks[0]
        if face_region:
            x0, y0, x1, y1 = face_region
            nx, ny = nose.x * width, nose.y * height
            if not (x0 <= nx <= x1 and y0 <= ny <= y1):
                continue
            distance = ((nx - (x0 + x1) / 2) / max(1, x1 - x0)) ** 2 + ((ny - (y0 + y1) / 2) / max(1, y1 - y0)) ** 2
        else:
            distance = 0
        candidates.append((distance, index))
    if not candidates or (not face_region and len(candidates) != 1):
        return dict(analysis_status="uncertain", reason="body_not_identified")
    candidates.sort()
    index = candidates[0][1]
    screen = result.pose_landmarks[index]
    shoulders = [screen[11], screen[12]]
    if any(not (0.015 < p.x < 0.985 and 0.015 < p.y < 0.985) or
           not math.isfinite(p.visibility) or p.visibility < 0.8 or
           not math.isfinite(p.presence) or p.presence < 0.8 for p in shoulders):
        return dict(analysis_status="uncertain", reason="shoulders_not_reliable")
    if math.hypot((shoulders[1].x - shoulders[0].x) * width,
                  (shoulders[1].y - shoulders[0].y) * height) < 40:
        return dict(analysis_status="uncertain", reason="shoulders_too_small")
    world = result.pose_world_landmarks[index]
    if len(world) < 13:
        return dict(analysis_status="uncertain", reason="body_world_landmarks_missing")
    try:
        yaw = body_yaw_from_shoulders(world[12], world[11])
    except ValueError as exc:
        return dict(analysis_status="uncertain", reason="body_geometry_ambiguous", message=str(exc))
    return dict(analysis_status="ok", reason="shoulder_pose", body_yaw_degrees=yaw,
                shoulder_visibility=min(p.visibility for p in shoulders))


def classify_body_image(img, face_region=None, cancel_check=None):
    first = classify_body_once(img, face_region)
    if first.get("analysis_status") != "ok":
        return first
    if cancel_check and cancel_check():
        return dict(analysis_status="uncertain", reason="body_cancelled")
    mirrored_region = None
    if face_region:
        x0, y0, x1, y1 = face_region
        mirrored_region = (img.shape[1] - x1, y0, img.shape[1] - x0, y1)
    second = classify_body_once(cv2.flip(img, 1), mirrored_region)
    if second.get("analysis_status") != "ok":
        return dict(analysis_status="uncertain", reason="body_mirror_unreliable")
    a, b = first["body_yaw_degrees"], -second["body_yaw_degrees"]
    if abs(a - b) > 20:
        return dict(analysis_status="uncertain", reason="body_mirror_disagreement",
                    body_original_yaw_degrees=a, body_mirrored_yaw_degrees=b, body_mirror_difference=abs(a - b))
    return dict(analysis_status="ok", reason="shoulder_pose_mirror_checked",
                body_yaw_degrees=(a + b) / 2,
                body_mirror_difference=abs(a - b),
                shoulder_visibility=min(first["shoulder_visibility"], second["shoulder_visibility"]))


def smoothstep01(value):
    value = max(0.0, min(1.0, float(value)))
    return value * value * (3.0 - 2.0 * value)


def body_turn_strength(yaw_degrees):
    """Continuous confidence-like strength for the directional body cue.

    This is deliberately a composition weight, not a claim about model
    probability. The old hard 12-degree cutoff made 11.9 and 12.0 degrees
    behave radically differently. The 6..18 smoothstep keeps weak shoulder
    yaw nearly neutral and reaches the historical 70/30 mix gradually.
    """
    span = BODY_TURN_BLEND_FULL_DEGREES - BODY_TURN_BLEND_START_DEGREES
    if span <= 0:
        return 1.0 if abs(float(yaw_degrees)) >= BODY_TURN_BLEND_FULL_DEGREES else 0.0
    position = (abs(float(yaw_degrees)) - BODY_TURN_BLEND_START_DEGREES) / span
    return smoothstep01(position)


def combine_body_and_head(head, body):
    head = head or head_result("uncertain", "head_missing")
    body = body or dict(analysis_status="uncertain", reason="body_missing")
    head_ok = head.get("analysis_status") == "ok"
    body_ok = body.get("analysis_status") == "ok"
    answer = dict(head, body_status=body.get("analysis_status"), body_reason=body.get("reason"),
                  head_status=head.get("analysis_status"), head_turn=head.get("turn"))
    for key in ("body_original_yaw_degrees", "body_mirrored_yaw_degrees", "body_mirror_difference"):
        if key in body:
            answer[key] = body[key]
    if body_ok:
        body_yaw = float(body["body_yaw_degrees"])
        body_strength = body_turn_strength(body_yaw)
        head_turn = float(head.get("turn", 0.0)) if head_ok else 0.0
        if head_ok:
            # A near-frontal body is weak evidence about left/right direction,
            # so it must not crush a mirror-confirmed head turn to 30%. As the
            # shoulders turn, the blend continuously approaches the historical
            # 70% body / 30% head composition.
            # Scale the historical body share itself instead of renormalizing
            # it against the head. At strength 0 the head keeps 100%; at
            # strength 1 the original 70/30 composition is restored.
            body_weight = BODY_BASE_WEIGHT * body_strength

            # Opposite directions also transition continuously. Strong, clear
            # disagreement still gives the body priority, but there is no new
            # numerical cliff at 12 degrees.
            opposite = body_yaw * head_turn < 0
            conflict_strength = min(body_strength, body_turn_strength(head_turn)) if opposite else 0.0
            body_weight += (1.0 - body_weight) * conflict_strength
            angle = body_weight * body_yaw + (1.0 - body_weight) * head_turn
            answer["pose_conflict"] = bool(conflict_strength > 0.0)
            answer["pose_conflict_strength"] = conflict_strength
        else:
            # With no reliable head, retain the body cue but fade weak yaw
            # smoothly towards neutral instead of switching it on at 12°.
            body_weight = body_strength
            angle = body_yaw * body_strength
            answer["pose_conflict"] = False
            answer["pose_conflict_strength"] = 0.0
        answer.update(analysis_status="ok", reason="body_head_pose", method="body_head_combined",
                      turn=angle, body_yaw_degrees=body_yaw, body_strength=body_strength,
                      body_weight=body_weight, shoulder_visibility=body.get("shoulder_visibility"),
                      body_mirror_difference=body.get("body_mirror_difference"))
    # Unreliable shoulders never replace a functioning head estimate, nor do
    # repeated body-only failures trip the head/gender circuit breakers.
    return answer


def detect_caption_top(img, face_region):
    """Find a white caption/footer only when a real transition into it exists.

    A broad white shirt against a white background can create full-width white
    rows directly below the face. The old first-white-run rule interpreted that
    as the caption and could leave almost no garment pixels. We now require a
    sustained white run *and* visibly less-white rows immediately above it. If
    the boundary is ambiguous, keeping a little footer is safer than deleting
    the actual clothing sample.
    """
    if face_region is None or img is None or img.size == 0:
        return None
    _, y0, _, y1 = face_region
    fh = max(1.0, float(y1 - y0))
    height = img.shape[0]
    white_rows = np.mean(np.all(img > 248, axis=2), axis=1)
    # A caption is a lower-page element. Start well below the face and at
    # least in the lower half of the preview. If a white garment/background
    # is already white at this point, the run is deliberately treated as
    # ambiguous and is not used as a crop boundary.
    scan_start = max(1, int(y1 + fh * .75), int(height * .55))
    run_start = None
    run_length = 0
    for row in range(scan_start, height):
        if white_rows[row] >= .985:
            if run_start is None:
                run_start = row
            run_length += 1
        else:
            run_start = None
            run_length = 0
            continue
        if run_length < 8:
            continue
        candidate = run_start
        # A footer should begin after a transition from photographic content.
        # Never accept a white run that was already in progress at scan_start.
        if candidate <= scan_start + 1:
            continue
        pre_start = max(scan_start, candidate - 12)
        before = white_rows[pre_start:candidate]
        if len(before) < 4:
            continue
        if float(np.mean(before)) > .92 and float(np.min(before)) > .80:
            continue
        # Tiny white bands inside clothes are not useful footer boundaries.
        if height - candidate < max(20, int(fh * .20)):
            continue
        return candidate
    return None


def classify_clothing_colors(img, face_region, cancel_check=lambda: False):
    """Deterministic dominant Lab palette in a face-anchored chest region.

    This is a garment colour estimate, not general-purpose body segmentation.
    Narrow central sampling avoids most background; skin and the collar are
    excluded. Neutral white/black fabric remains a valid colour.
    """
    if face_region is None:
        return dict(analysis_status="uncertain", reason="color_face_missing", palette=[])
    x0, y0, x1, y1 = face_region
    fw, fh = x1 - x0, y1 - y0
    cx = (x0 + x1) / 2.0
    h, w = img.shape[:2]
    caption_top = detect_caption_top(img, face_region)
    if caption_top is not None:
        h = caption_top
    top, bottom = max(0, int(y1 + fh * .05)), min(h, int(y1 + fh * 1.65))
    left, right = max(0, int(cx - fw * .85)), min(w, int(cx + fw * .85))
    if bottom - top < 24 or right - left < 24:
        return dict(analysis_status="uncertain", reason="color_clothing_outside_image", palette=[])
    roi = img[top:bottom, left:right]
    # Keep computation bounded for large previews. No extra image/model reads.
    scale = min(1.0, 160.0 / max(roi.shape[:2]))
    if scale < 1:
        roi = cv2.resize(roi, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    rh, rw = roi.shape[:2]
    yy, xx = np.mgrid[:rh, :rw]
    nx = (xx + .5) / rw * 2 - 1
    ny = (yy + .5) / rh
    # Sample across the upper torso, widening below the collar. A narrow centre
    # alone can mistake a tie/white collar for the main jacket or pinafore.
    mask = (np.abs(nx) < (.55 - .05 * ny + .20 * (ny > .35))) & (ny > .10) & (ny < .90)
    ycc = cv2.cvtColor(roi, cv2.COLOR_BGR2YCrCb)
    skin = ((ycc[:, :, 1] > 135) & (ycc[:, :, 1] < 175) &
            (ycc[:, :, 2] > 85) & (ycc[:, :, 2] < 130) &
            (roi[:, :, 2].astype(float) > roi[:, :, 0].astype(float) * 1.15))
    mask &= ~(skin & (ny < .30))
    pixels = roi[mask]
    if len(pixels) < 128 or cancel_check():
        return dict(analysis_status="uncertain", reason="color_insufficient_clothing", palette=[])
    pixels = pixels[np.linspace(0, len(pixels) - 1, min(2500, len(pixels)), dtype=int)]
    lab = cv2.cvtColor(pixels.reshape(-1, 1, 3).astype(np.float32) / 255.0,
                       cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(float)
    # Histogram seeds depend on color support, not scan order or a noisy pixel.
    bins, inverse, mass = np.unique(np.floor(lab / [4.0, 6.0, 6.0]).astype(int),
                                    axis=0, return_inverse=True, return_counts=True)
    means = np.zeros((len(bins), 3))
    np.add.at(means, inverse, lab)
    means /= mass[:, None]
    centers = [means[np.argmax(mass)]]
    for _ in range(3):
        distances = np.min(np.sum((means[:, None, :] - np.array(centers)[None, :, :]) ** 2, axis=2), axis=1)
        supported = mass >= max(3, len(lab) * .01)
        weighted = np.where(supported, distances * mass, 0)
        if np.max(weighted) == 0 or distances[np.argmax(weighted)] < 100:
            break
        centers.append(means[np.argmax(weighted)])
    centers = np.array(centers)
    for _ in range(15):
        if cancel_check():
            return dict(analysis_status="uncertain", reason="cancelled", palette=[])
        labels = np.argmin(np.sum((lab[:, None, :] - centers[None, :, :]) ** 2, axis=2), axis=1)
        updated = np.array([np.mean(lab[labels == i], axis=0) if np.any(labels == i) else centers[i]
                            for i in range(len(centers))])
        if np.max(np.abs(updated - centers)) < .05:
            centers = updated
            break
        centers = updated
    labels = np.argmin(np.sum((lab[:, None, :] - centers[None, :, :]) ** 2, axis=2), axis=1)
    palette = [dict(lab=[round(float(v), 3) for v in center],
                    weight=float(np.mean(labels == i))) for i, center in enumerate(centers)
               if np.mean(labels == i) >= .06]
    palette.sort(key=lambda c: -c["weight"])
    total = sum(c["weight"] for c in palette)
    for color in palette:
        color["weight"] = round(color["weight"] / total, 6)
    return dict(analysis_status="ok", reason="", palette=palette,
                method="face_anchored_clothing_lab_histogram", sample_count=len(pixels))


def analyze_photo(payload, state):
    """One read and one YuNet crop for both optional features."""
    want_gender = payload.get("gender") is True
    want_head = payload.get("head_turn") is True
    want_color = payload.get("color") is True
    answer = {"id": payload.get("id"), "gender": None, "head_turn": None, "color": None}
    if not want_gender and not want_head and not want_color:
        raise ValueError("analyze_image requires at least one feature")
    img = read_image(payload.get("path"))
    selected, reason = (choose_face(img, with_region=True) if img is not None else (None, "image_read_failed"))
    if selected is None:
        status = "technical_failure" if reason == "image_read_failed" else "not_applicable"
        if want_gender:
            answer["gender"] = dict(sex="U", confidence=0.0, source="unknown", reason=reason,
                                    needs_image=False, analysis_status=status)
        if want_head:
            answer["head_turn"] = head_result(status, reason)
        if want_color:
            answer["color"] = dict(analysis_status="technical_failure" if img is None else "uncertain", reason=reason, palette=[])
        return answer
    face_crop, face_score = selected[:2]
    if request_cancelled(state):
        return answer
    def head_job():
        if request_cancelled(state):
            return None
        try:
            return classify_head_crop(face_crop, lambda: request_cancelled(state))
        except Exception as exc:
            logging.exception("Head turn analysis failed")
            return head_result("technical_failure", "head_exception", message=str(exc))

    def body_job():
        if request_cancelled(state):
            return None
        try:
            return classify_body_image(img, selected[2] if len(selected) > 2 else None,
                                       lambda: request_cancelled(state))
        except Exception as exc:
            logging.exception("Body turn analysis failed; retaining head estimate")
            return dict(analysis_status="technical_failure", reason="body_exception", message=str(exc))

    futures = []
    try:
        if want_head:
            futures.append(analysis_pool.submit(head_job))
            futures.append(analysis_pool.submit(body_job))
        if want_gender and not request_cancelled(state):
            try:
                answer["gender"] = classify_gender_crop(face_crop, face_score, lambda: request_cancelled(state))
            except Exception as exc:
                logging.exception("Gender image analysis failed")
                answer["gender"] = dict(sex="U", confidence=0.0, source="unknown", reason="gender_exception",
                                        needs_image=False, analysis_status="technical_failure", message=str(exc))
        if want_color and not request_cancelled(state):
            try:
                answer["color"] = classify_clothing_colors(img, selected[2] if len(selected) > 2 else None,
                                                           lambda: request_cancelled(state))
            except Exception as exc:
                logging.exception("Clothing color analysis failed")
                answer["color"] = dict(analysis_status="technical_failure", reason="color_exception", palette=[], message=str(exc))
        if futures:
            head, body = [future.result() for future in futures]
            if not request_cancelled(state):
                answer["head_turn"] = combine_body_and_head(head, body) if body is not None else head
    finally:
        # Native inference cannot be interrupted inside detect(). Keep ownership
        # of the request/image until every worker exits, including on cancellation.
        for future in futures:
            future.result()
    return answer


def row_rhythm_profile(size, mode):
    if mode == "auto" or size <= 1:
        return [0.0] * size
    if mode in ("alternateWide", "alternateNarrow"):
        # Preserve the selected first row. Arithmetic remainder deviations go
        # to later rows, after filling preferred long rows in reading order.
        bias = 1 / (4 * size * size)
        return [1 - i * bias if i % 2 == (0 if mode == "alternateWide" else 1) else i * bias
                for i in range(size)]
    middle, minimum = (size - 1) / 2, 0 if size % 2 else .5
    span = middle - minimum
    central = [1 - (abs(i - middle) - minimum) / span if span > 0 else 1 for i in range(size)]
    return central if mode == "centerWide" else [1 - value for value in central]


def vertical_row_score(counts, mode):
    n = len(counts)
    if not n: return (0,)
    singles = sum(c == 1 for c in counts) if n > 1 else 0
    excess = max(0, max(counts) - min(counts) - 2)
    variance = sum(c*c for c in counts) - sum(counts)**2/n
    mirror = tuple(abs(counts[i]-counts[n-1-i]) for i in range(n//2))
    mirror += (0,) * (sum(counts)//2-len(mirror))
    if mode == 'auto' or n <= 1: return (singles, excess, round(variance, 8)) + mirror
    violations = severity = 0
    middle = (n-1)/2
    for i in range(1,n):
        delta = counts[i]-counts[i-1]
        if mode in ('alternateWide','alternateNarrow'):
            wants_more = (i%2==0) == (mode=='alternateWide')
            wrong = max(0,1-(delta if wants_more else -delta))
        else:
            toward = abs(i-middle)<abs(i-1-middle)
            away = abs(i-middle)>abs(i-1-middle)
            increase = toward if mode=='centerWide' else away
            wrong = max(0,-delta if increase else delta) if toward or away else 0
        if wrong: violations+=1;severity+=wrong
    tie = -sum(c*p for c,p in zip(counts,row_rhythm_profile(n,mode)))
    return (excess,singles,violations,severity) + mirror + (round(variance,8),round(tie,10))


def improve_vertical_counts(counts, mode, feasible=None, check=None):
    best = list(counts)
    if mode == 'auto' or len(best)<=1:return best
    score = vertical_row_score(best,mode)
    for _ in range(min(12,len(best)*2)):
        if check:check()
        next_,next_score = best,score
        for a in range(len(best)):
            if best[a]<=1:continue
            for b in range(len(best)):
                if a==b:continue
                trial=best.copy();trial[a]-=1;trial[b]+=1
                quality=vertical_row_score(trial,mode)
                if quality<next_score and (feasible is None or feasible(trial)):
                    next_,next_score=trial,quality
        if next_ is best:break
        best,score=next_,next_score
    return best


def row_rhythm_cost(counts, mode):
    if mode == "auto" or len(counts) <= 1 or max(counts) == min(counts):
        return 0.0
    low, span = min(counts), max(counts) - min(counts)
    return sum(((count - low) / span - target) ** 2
               for count, target in zip(counts, row_rhythm_profile(len(counts), mode))) / len(counts)


def balanced_zone_counts(order, width, height, row_count, scale, gx, gy, check, rhythm="auto", profile=None):
    """Exact height/balance Pareto frontier for a fixed zone population/rows."""
    n = len(order)
    if row_count <= 1 or n <= row_count:
        return None
    metrics = []
    for start in range(n):
        row, w, h = {}, 0.0, 0.0
        for end in range(start, n):
            w += order[end]["width"]; h = max(h, order[end]["height"])
            row[end - start + 1] = (w, h)
        metrics.append(row)
    limit_w, limit_h = width / scale, height / scale - gy * (row_count - 1)
    center = (row_count - 1) / 2 - .1
    if profile is None: profile = row_rhythm_profile(row_count, rhythm)
    states = {0: [(0.0, (0, 0, 0.0, 0.0), [])]}
    for r in range(row_count):
        check()
        next_states = {}
        for consumed, frontier in states.items():
            check()
            for count in range(1, n - consumed - (row_count - r - 1) + 1):
                w, rh = metrics[consumed][count]
                if w + gx * (count - 1) > limit_w + 1e-9: break
                end = consumed + count
                if r == row_count - 1 and end != n: continue
                for old_h, old_score, old_counts in frontier:
                    h = old_h + rh
                    if h > limit_h + 1e-9: continue
                    score = (old_score[0] + (count == 1), old_score[1] + count * count,
                             old_score[2] - count * profile[r],
                             old_score[3] + count * (r - center) ** 2)
                    out = next_states.setdefault(end, [])
                    if any(fh <= h + 1e-9 and fs <= score for fh, fs, _ in out): continue
                    out[:] = [(fh, fs, fc) for fh, fs, fc in out if not (h <= fh + 1e-9 and score <= fs)]
                    out.append((h, score, old_counts + [count]))
        states = next_states
    feasible = states.get(n)
    return min(feasible, key=lambda x: x[1])[2] if feasible else None


def render_zone_layout(row_specs, by_id, zones, scale, gx, gy, multiplier, align):
    """Shared final coordinates/gaps for geometry and composition solvers.

    Callers validate feasibility and IDs. This function does not search or alter
    scale: it applies the same alignment policy to either solver's row assignment.
    """
    specs, grouped = [], {}
    for source in row_specs:
        row = dict(source)
        if "contentWidth" not in row: row["contentWidth"] = sum(by_id[i]["width"] for i in row["ids"])
        if "rowHeight" not in row: row["rowHeight"] = max(by_id[i]["height"] for i in row["ids"])
        specs.append(row)
        grouped.setdefault(row["zoneIndex"], []).append(row)
    gap_y = gy * scale * multiplier
    has_vertical = False
    for zi, rows in grouped.items():
        if len(rows) > 1:
            has_vertical = True
            zone = zones[zi]
            gap_y = min(gap_y, (zone["bottom"] - zone["top"] - sum(r["rowHeight"] for r in rows) * scale) / (len(rows) - 1))
    gap_y = max(gy * scale, gap_y) if has_vertical else 0.0
    uniform_gap = gx * scale * multiplier
    if align != "justify":
        for row in specs:
            if len(row["ids"]) > 1:
                z = zones[row["zoneIndex"]]
                limit = (z["right"] - z["left"] - row["contentWidth"] * scale) / (len(row["ids"]) - 1)
                uniform_gap = min(uniform_gap, limit)
        uniform_gap = max(gx * scale, uniform_gap)
    def horizontal_gap(row):
        count = len(row["ids"])
        zone = zones[row["zoneIndex"]]
        if count <= 1: return 0.0
        if align == "justify":
            return (zone["right"] - zone["left"] - row["contentWidth"] * scale) / (count - 1)
        return uniform_gap
    placements = []
    for zi,z in enumerate(zones):
        rows = grouped.get(zi, [])
        height = sum(r["rowHeight"] for r in rows) * scale + max(0, len(rows) - 1) * gap_y
        top = z["top"] + (z["bottom"] - z["top"] - height) / 2
        block_width = max((r["contentWidth"] * scale + max(0, len(r["ids"]) - 1) * horizontal_gap(r) for r in rows), default=0.0)
        inset = max(0.0, z["right"] - z["left"] - block_width) / 2
        for row in rows:
            count = len(row["ids"])
            gap_x = horizontal_gap(row)
            width = row["contentWidth"] * scale + max(0, count - 1) * gap_x
            x = z["left"] + inset if align == "left" else z["left"] if align == "justify" and count > 1 else z["right"] - inset - width if align == "right" else z["left"] + (z["right"] - z["left"] - width) / 2
            row.update(top=top, gapX=gap_x)
            for id_ in row["ids"]:
                item = by_id[id_]
                placements.append(dict(id=id_, centerX=x + item["width"] * scale / 2,
                                       centerY=top + item["height"] * scale / 2, scale=scale))
                x += item["width"] * scale + gap_x
            top += row["rowHeight"] * scale + gap_y
    return dict(status="ok", commonScale=scale, gapY=gap_y, rows=specs, placements=placements)


def layout_priority(item):
    rank = item.get("priority", 1)
    if type(rank) is not int or rank not in (0, 1, 2):
        raise ValueError("Invalid layer label priority")
    return rank


def calculate_zone_layout(payload, state, time_budget=30.0):
    """Bounded multi-zone DP. No images or detection models are used here."""
    started = time.monotonic()
    deadline = started + time_budget
    steps = 0
    def check():
        nonlocal steps
        steps += 1
        if steps > 1000000:
            raise TimeoutError("Layout operation budget exhausted")
        if request_cancelled(state):
            raise InterruptedError("Layout cancelled")
        if time.monotonic() > deadline:
            raise TimeoutError("Layout search budget exhausted")
    def number(value, positive=False):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("Non-finite layout number")
        if abs(value) > 1e8 or (positive and value <= 0):
            raise ValueError("Invalid layout dimension")
        return float(value)
    if not isinstance(payload, dict):
        raise ValueError("layout_zones payload must be an object")
    no_enlarge = payload.get("noEnlarge", False)
    if type(no_enlarge) is not bool: raise ValueError("Invalid no-enlargement flag")
    items, zones = payload.get("items"), payload.get("zones")
    if not isinstance(items, list) or not 1 <= len(items) <= 500 or not isinstance(zones, list) or not 1 <= len(zones) <= 128:
        raise ValueError("Unsupported item/zone count")
    items = [dict(id=item["id"], width=number(item["width"], True), height=number(item["height"], True), priority=layout_priority(item)) for item in items]
    items.sort(key=lambda item: item["priority"])
    if len({item["id"] for item in items}) != len(items) or any(type(i["id"]) is not int for i in items):
        raise ValueError("Layout IDs must be unique integers")
    clean_zones = []
    for index, zone in enumerate(zones):
        z = {key: number(zone[key]) for key in ("left", "top", "right", "bottom")}
        z.update(width=number(z["right"] - z["left"], True), height=number(z["bottom"] - z["top"], True),
                 component=zone["componentIndex"], index=index)
        if type(z["component"]) is not int or not 0 <= z["component"] < 128:
            raise ValueError("Invalid component index")
        clean_zones.append(z)
    zones = clean_zones
    for i, a in enumerate(zones):
        for b in zones[i + 1:]:
            if min(a["right"], b["right"]) - max(a["left"], b["left"]) > 1e-8 and min(a["bottom"], b["bottom"]) - max(a["top"], b["top"]) > 1e-8:
                raise ValueError("Layout zones overlap")
    gx, gy = number(payload.get("baseGapX", 0)), number(payload.get("baseGapY", 0))
    multiplier = number(payload.get("maxGapMultiplier", 3), True)
    if gx < 0 or gy < 0 or not 1 <= multiplier <= 4:
        raise ValueError("Invalid gap settings")
    desired = payload.get("rows", 0)
    if type(desired) is not int or not 0 <= desired <= len(items):
        raise ValueError("Invalid row count")
    rhythm = payload.get("rowRhythm", "auto")
    align = payload.get("horizontalAlign", "center")
    if rhythm not in ("auto", "centerWide", "edgesWide", "alternateWide", "alternateNarrow") or align not in ("left", "right", "center", "justify"):
        raise ValueError("Invalid layout policy")
    components = {z["component"] for z in zones}
    required = sum(1 << c for c in components) if len(items) >= len(components) else 0
    total_zone_area = sum(z["width"] * z["height"] for z in zones)
    n = len(items)
    def rhythm_cost(counts):
        return row_rhythm_cost(counts, rhythm)
    def search(scale, metrics, area_prefix):
        # State keeps exact consumed count and component mask; fixed-row mode
        # also keeps row count. Per-zone DP tests every consecutive row split.
        states = {(0, 0, 0): (0.0, [], [])}
        for z in zones:
            check()
            options_cache = {}
            def options(start):
                if start in options_cache: return options_cache[start]
                remaining = n - start
                dp = {(0, 0): (0.0, [])}
                by_consumed = {0: [(0, 0.0, [])]}
                for consumed in range(remaining):
                    check()
                    for rows_count, height, counts in by_consumed.get(consumed, []):
                        if desired and rows_count >= desired: continue
                        for count in range(1, remaining - consumed + 1):
                            width, rh = metrics[start + consumed][count]
                            if (width + gx * (count - 1)) * scale > z["width"] + 1e-9: break
                            next_height = height + rh * scale + (gy * scale if rows_count else 0)
                            if next_height > z["height"] + 1e-9: continue
                            nc, nr = consumed + count, rows_count + 1
                            key = (nc, nr if desired or rhythm != "auto" else 0)
                            old = dp.get(key)
                            if old is None or next_height < old[0] - 1e-9 or (abs(next_height - old[0]) <= 1e-9 and rhythm_cost(counts + [count]) < rhythm_cost(old[1])):
                                dp[key] = (next_height, counts + [count])
                    # All predecessors of the next consumed count are complete.
                    if consumed + 1 <= remaining:
                        by_consumed[consumed + 1] = [(len(v[1]), v[0], v[1]) for k, v in dp.items() if k[0] == consumed + 1]
                result = [(key[0], value[1]) for key, value in dp.items() if key[0] > 0]
                options_cache[start] = result
                return result
            next_states = {}
            for (start, _, mask), (penalty, assignments, counts) in states.items():
                check()
                variants = [(0, [])] + options(start) if start < n else [(0, [])]
                for amount, row_counts in variants:
                    used = start + amount
                    new_counts = counts + row_counts
                    if desired and len(new_counts) > desired: continue
                    new_mask = mask | (1 << z["component"]) if amount else mask
                    if required and n - used < (required & ~new_mask).bit_count(): continue
                    target = area_prefix[-1] * (z["width"] * z["height"]) / total_zone_area
                    allocated = area_prefix[used] - area_prefix[start]
                    cost = penalty + ((allocated - target) / max(1, target)) ** 2
                    key = (used, len(new_counts) if desired or rhythm != "auto" else 0, new_mask)
                    candidate = (cost, assignments + [(z["index"], start, row_counts)], new_counts)
                    old = next_states.get(key)
                    if old is None or (cost, rhythm_cost(new_counts)) < (old[0], rhythm_cost(old[2])):
                        next_states[key] = candidate
            states = next_states
            if not states: return None
        feasible = [v for (used, rows_count, mask), v in states.items()
                    if used == n and (not desired or rows_count == desired) and (not required or mask & required == required)]
        return min(feasible, key=lambda v: (v[0], rhythm_cost(v[2]), len(v[2]))) if feasible else None
    def exact_scale(allocation, metrics):
        limit = math.inf
        for zi, start, counts in allocation[1]:
            if not counts:
                continue
            height = 0.0
            for count in counts:
                width, rh = metrics[start][count]
                limit = min(limit, zones[zi]["width"] / (width + gx * (count - 1)))
                height += rh
                start += count
            limit = min(limit, zones[zi]["height"] / (height + gy * (len(counts) - 1)))
        return math.nextafter(limit, 0.0)

    orders = [items]
    for key in (lambda i: (-i["height"], -i["width"], i["id"]),
                lambda i: (-i["width"] / i["height"], i["id"]),
                lambda i: (i["width"] / i["height"], i["id"])):
        candidate = sorted(items, key=lambda i: (i["priority"],) + key(i))
        if [i["id"] for i in candidate] not in [[i["id"] for i in order] for order in orders]: orders.append(candidate)
    if n <= 6:
        signatures = {tuple((i["priority"], i["width"], i["height"]) for i in order) for order in orders}
        for candidate in itertools.permutations(items):
            if any(a["priority"] > b["priority"] for a,b in zip(candidate, candidate[1:])): continue
            signature = tuple((i["priority"], i["width"], i["height"]) for i in candidate)
            if signature not in signatures:
                signatures.add(signature)
                orders.append(list(candidate))
    else:
        for candidate in (sorted(items, key=lambda i: (i["priority"], i["height"], i["width"], i["id"])),
                          sorted(items, key=lambda i: (i["priority"], -i["width"] * i["height"], i["id"]))):
            if [i["id"] for i in candidate] not in [[i["id"] for i in order] for order in orders]:
                orders.append(candidate)
    best = None
    tested = 0
    budget_exhausted = False
    try:
        for order_index, order in enumerate(orders):
            check()
            metrics = []
            area_prefix = [0.0]
            for start in range(n):
                table, width, rh = {}, 0.0, 0.0
                for end in range(start, n):
                    width += order[end]["width"]; rh = max(rh, order[end]["height"])
                    table[end - start + 1] = (width, rh)
                metrics.append(table)
                area_prefix.append(area_prefix[-1] + order[start]["width"] * order[start]["height"])
            if no_enlarge:
                allocation = search(1.0, metrics, area_prefix); tested += 1
                if allocation is not None and (best is None or
                        (allocation[0], rhythm_cost(allocation[2]), len(allocation[2])) <
                        (best[2][0], rhythm_cost(best[2][2]), len(best[2][2]))):
                    best = (1.0, order, allocation, metrics)
                if allocation is not None or (best is not None and best[0] == 1.0): continue
            high = min(1.0 if no_enlarge else math.inf, max(z["width"] for z in zones) / max(i["width"] for i in order),
                       max(z["height"] for z in zones) / max(i["height"] for i in order))
            low = 0.0
            # Subsequent orders first prove that they improve the current scale.
            if best:
                probe = search(best[0], metrics, area_prefix); tested += 1
                if probe is None: continue
                low = best[0]
            for _ in range(20 if order_index == 0 else 16):
                check()
                scale = (low + high) / 2
                allocation = search(scale, metrics, area_prefix); tested += 1
                if allocation is None: high = scale
                else:
                    low = max(scale, min(1.0, exact_scale(allocation, metrics)) if no_enlarge else exact_scale(allocation, metrics))
                    if best is None or low > best[0] + 1e-10 or (abs(low - best[0]) <= 1e-10 and (allocation[0], rhythm_cost(allocation[2]), len(allocation[2])) < (best[2][0], rhythm_cost(best[2][2]), len(best[2][2]))):
                        best = (low, order, allocation, metrics)
    except TimeoutError:
        budget_exhausted = True
    if best is None:
        return dict(status="fallback", reason="No complete layout within search budget", tested=tested)
    scale, order, allocation, metrics = best
    row_specs = []
    # Refine the winning allocation with a bounded height/balance frontier.
    # Explicit rhythm may use the shared 1% scale allowance; auto keeps scale.
    balance_deadline = time.monotonic() + 3.0
    def balance_check():
        if request_cancelled(state): raise InterruptedError("Layout cancelled")
        if time.monotonic() > balance_deadline: raise TimeoutError("Row balancing budget exhausted")
    full_profile = row_rhythm_profile(len(allocation[2]), rhythm)
    row_offset = 0
    for zi, start, counts in allocation[1]:
        if counts:
            zone = zones[zi]
            try:
                improved = balanced_zone_counts(order[start:start + sum(counts)], zone["width"], zone["height"],
                                                len(counts), scale if rhythm == "auto" else scale * (1 - COMPOSITION_MAX_SCALE_LOSS),
                                                gx, gy, balance_check, rhythm, full_profile[row_offset:row_offset + len(counts)])
                if improved: counts = improved
            except TimeoutError:
                budget_exhausted = True
        row_offset += len(counts)
        for count in counts:
            width, height = metrics[start][count]
            row_specs.append(dict(zoneIndex=zi, ids=[i["id"] for i in order[start:start + count]], contentWidth=width, rowHeight=height))
            start += count
    if rhythm != "auto":
        initial_counts = [len(row["ids"]) for row in row_specs]
        def rebuild_counts(counts):
            specs, offset, groups = [], 0, {}
            for old, count in zip(row_specs, counts):
                zi = old["zoneIndex"]
                groups.setdefault(zi, [0, 0.0, []])
                groups[zi][0] += count
                w, h = metrics[offset][count]
                specs.append(dict(zoneIndex=zi, ids=[i["id"] for i in order[offset:offset+count]], contentWidth=w, rowHeight=h))
                offset += count
            for zi, amount, original in allocation[1]:
                if sum(original) != groups.get(zi, [0])[0]: return None
            minimum = scale * (1 - COMPOSITION_MAX_SCALE_LOSS)
            for zi in groups:
                selected = [row for row in specs if row["zoneIndex"] == zi]
                if any((row["contentWidth"] + gx * (len(row["ids"])-1))*minimum > zones[zi]["width"]+1e-9 for row in selected): return None
                if (sum(row["rowHeight"] for row in selected)+gy*(len(selected)-1))*minimum > zones[zi]["height"]+1e-9:return None
            return specs
        try:
            refined = improve_vertical_counts(initial_counts, rhythm, lambda counts: rebuild_counts(counts) is not None, balance_check)
            improved_specs = rebuild_counts(refined)
            if improved_specs: row_specs = improved_specs
        except TimeoutError:
            budget_exhausted = True
    reference_scale = scale
    if rhythm != "auto":
        # Small caption/effect overhangs must not suppress the selected profile.
        # Recover the exact largest scale for the new rows, never exceeding the
        # original geometric optimum or spending more than the shared 1% cap.
        limit = scale
        for zi, zone in enumerate(zones):
            rows = [row for row in row_specs if row["zoneIndex"] == zi]
            if not rows: continue
            for row in rows:
                limit = min(limit, zone["width"] / (row["contentWidth"] + gx * (len(row["ids"]) - 1)))
            limit = min(limit, zone["height"] / (sum(row["rowHeight"] for row in rows) + gy * (len(rows) - 1)))
        if limit < scale: scale = math.nextafter(limit, 0.0)
    result = render_zone_layout(row_specs, {i["id"]:i for i in order}, zones, scale, gx, gy, multiplier, align)
    result["referenceScale"] = reference_scale
    result.update(tested=tested, orders=len(orders), searchSteps=steps, exhaustiveOrders=n <= 6,
                  budgetExhausted=budget_exhausted, elapsed=round(time.monotonic() - started, 3))
    return result


def composition_color_cost(plan, by_id, mode, distances):
    """Same physical-neighbour graph and weighted Lab energy distance as JSX."""
    if mode == "off": return 0.0
    def expected(a, b):
        return sum(p["weight"] * q["weight"] * math.dist(p["lab"], q["lab"]) for p in a for q in b)
    def distance(a, b):
        key = tuple(sorted((a,b)))
        if key not in distances:
            p,q=by_id[a]["colorPalette"],by_id[b]["colorPalette"]
            distances[key] = math.sqrt(max(0.0,2*expected(p,q)-expected(p,p)-expected(q,q)))
        return distances[key]
    positions = {p["id"]:p for p in plan["placements"]}
    physical = []
    for _,row in sorted(enumerate(plan["rows"]),key=lambda pair:(pair[1]["top"],pair[0])):
        if not physical or abs(physical[-1][0]-row["top"])>=1:
            physical.append((row["top"],[]))
        physical[-1][1].extend(positions[i] for i in row["ids"])
    for _,entries in physical:entries.sort(key=lambda p:(p["centerX"],by_id[p["id"]]["order"]))
    total=weight_sum=0.0;seen=set()
    def edge(a,b,weight):
        nonlocal total,weight_sum
        ia,ib=a["id"],b["id"]
        if not by_id[ia].get("colorPalette") or not by_id[ib].get("colorPalette"):return
        key=tuple(sorted((ia,ib)))
        if key in seen:return
        seen.add(key);total+=weight*distance(ia,ib);weight_sum+=weight
    for r,(_,entries) in enumerate(physical):
        for a,b in zip(entries,entries[1:]):edge(a,b,1.0)
        if r+1>=len(physical):continue
        below=physical[r+1][1]
        for a in entries:
            if below:
                nearest=min(below,key=lambda b:(b["centerX"]-a["centerX"])**2+(b["centerY"]-a["centerY"])**2)
                edge(a,nearest,.5)
    return (-1 if mode=="contrast" else 1)*(total/weight_sum if weight_sum else 0.0)


def calculate_composition_layout(payload, state, time_budget=14.0):
    """Bounded whole-sheet geometry/gender/pose search; never runs image models.

    Geometry is established first. Composition may spend at most 1% of linear
    scale. Keep complete feasible incumbents so a deadline never loses a plan.
    """
    started = time.monotonic()
    deadline = started + max(0.0, min(20.0, time_budget))
    # Existing geometry solver validates IDs, dimensions, zones and gap policy.
    baseline = calculate_zone_layout(payload, state, time_budget=min(8.0, max(0.0, time_budget * .6)))
    if baseline.get("status") != "ok":
        return baseline
    def check():
        if request_cancelled(state):
            raise InterruptedError("Composition search cancelled")
        if time.monotonic() >= deadline:
            raise TimeoutError("Composition search budget exhausted")
    use_gender, use_head = payload.get("useGender", False), payload.get("useHead", False)
    if type(use_gender) is not bool or type(use_head) is not bool:
        raise ValueError("Invalid composition flags")
    color_mode = payload.get("colorMode", "off")
    if color_mode not in ("off", "harmonious", "contrast"):
        raise ValueError("Invalid composition color mode")
    color_distances = {}
    no_enlarge = payload.get("noEnlarge", False)
    scale_loss_limit = COMPOSITION_MAX_SCALE_LOSS
    by_id = {}
    for order, source in enumerate(payload["items"]):
        item = dict(source, order=order, priority=layout_priority(source))
        sex = item.get("gender", "U")
        if sex not in ("M", "F", "U"):
            raise ValueError("Invalid composition gender")
        item["gender"] = sex
        for key in ("headTurnValid", "headLeanValid"):
            if type(item.get(key, False)) is not bool:
                raise ValueError("Invalid pose validity flag")
        for key, limit in (("headTurn", 180), ("headLean", 180), ("headLeanWeight", 1)):
            value = item.get(key, 0)
            if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > limit:
                raise ValueError("Invalid composition pose")
            item[key] = float(value)
        palette = item.get("colorPalette")
        if palette is not None:
            if not isinstance(palette,list) or not 1 <= len(palette) <= 4:
                raise ValueError("Invalid clothing palette")
            weight_sum = 0.0
            for swatch in palette:
                if not isinstance(swatch,dict): raise ValueError("Invalid clothing swatch")
                lab,weight=swatch.get("lab"),swatch.get("weight")
                if (not isinstance(lab,list) or len(lab)!=3 or type(weight) not in (int,float)
                        or not math.isfinite(weight) or not 0<weight<=1):
                    raise ValueError("Invalid clothing palette values")
                for channel,value in enumerate(lab):
                    if (type(value) not in (int,float) or not math.isfinite(value)
                            or (not 0<=value<=100 if channel==0 else abs(value)>128)):
                        raise ValueError("Invalid clothing Lab value")
                weight_sum+=weight
            if abs(weight_sum-1)>.01:raise ValueError("Invalid clothing palette weights")
        item["colorPalette"] = palette
        by_id[item["id"]] = item
    zones = payload["zones"]
    gx, gy = float(payload.get("baseGapX", 0)), float(payload.get("baseGapY", 0))
    multiplier = float(payload.get("maxGapMultiplier", 3))
    align, desired = payload.get("horizontalAlign", "center"), payload.get("rows", 0)
    rhythm = payload.get("rowRhythm", "auto")
    n = len(by_id)
    center = (min(z["left"] for z in zones) + max(z["right"] for z in zones)) / 2
    half = max(1.0, (max(z["right"] for z in zones) - min(z["left"] for z in zones)) / 2)
    def reflow(rows):
        if not rows or (desired and len(rows) != desired): return None
        if any(type(zi) is not int or not 0 <= zi < len(zones) or not row for zi,row in rows): return None
        ids = [id_ for zi, row in rows for id_ in row]
        if len(ids) != n or set(ids) != set(by_id): return None
        if any(by_id[a]["priority"] > by_id[b]["priority"] for a,b in zip(ids,ids[1:])): return None
        if any(a[0] > b[0] for a,b in zip(rows,rows[1:])): return None
        groups = {}
        scale = math.inf
        for zi, row in rows:
            groups.setdefault(zi, []).append(row)
            z = zones[zi]
            scale = min(scale, (z["right"] - z["left"]) / (sum(by_id[i]["width"] for i in row) + gx * (len(row) - 1)))
        used_components = {zones[zi]["componentIndex"] for zi in groups}
        components = {z["componentIndex"] for z in zones}
        if n >= len(components) and used_components != components: return None
        for zi, group in groups.items():
            z = zones[zi]
            scale = min(scale, (z["bottom"] - z["top"]) / (sum(max(by_id[i]["height"] for i in row) for row in group) + gy * (len(group) - 1)))
        if not math.isfinite(scale) or scale <= 0: return None
        if no_enlarge and scale >= 1: scale = 1.0
        else: scale = math.nextafter(scale, 0.0)
        specs = [dict(zoneIndex=zi, ids=list(ids)) for zi,ids in rows]
        return render_zone_layout(specs, by_id, zones, scale, gx, gy, multiplier, align)
    def score(plan):
        positions = {p["id"]: p["centerX"] for p in plan["placements"]}
        bad = good = symmetry = vertical = 0
        minority_center = head = 0.0
        previous = []
        counts = []
        for row in plan["rows"]:
            ids = row["ids"]; counts.append(len(ids))
            sexes = [by_id[i]["gender"] for i in ids]
            if use_gender:
                for a, b in zip(sexes, sexes[1:]):
                    if a != "U" and b != "U":
                        bad += a == b; good += a != b
                m, f = sexes.count("M"), sexes.count("F")
                if m and f and abs(m - f) > 1:
                    symmetry += sum(a != b for a, b in zip(sexes[:len(sexes)//2], reversed(sexes)))
                    minority = "M" if m < f else "F"
                    local_center = (positions[ids[0]] - by_id[ids[0]]["width"] * plan["commonScale"] / 2 + positions[ids[-1]] + by_id[ids[-1]]["width"] * plan["commonScale"] / 2) / 2
                    pitch = max(1e-7, (positions[ids[-1]] - positions[ids[0]]) / (len(ids) - 1))
                    minority_center += sum(((positions[i] - local_center) / pitch) ** 2 for i in ids if by_id[i]["gender"] == minority)
                for a, b in zip(sexes, previous):
                    if a != "U" and b != "U": vertical += 1 if a != b else -1
            if use_head:
                prev_turn = None
                for id_ in ids:
                    item = by_id[id_]
                    if not item.get("headTurnValid", False): prev_turn = None; continue
                    turn, target = item["headTurn"] / 80, (center - positions[id_]) / half
                    head += (turn - target) ** 2
                    if prev_turn is not None: head += .35 * max(0, turn - prev_turn) ** 2
                    if item.get("headLeanValid", False): head += .15 * item["headLeanWeight"] * (item["headLean"] / 30 - target) ** 2
                    prev_turn = turn
            previous = sexes
        # Geometric row quality and the user's rhythm precede optional
        # semantic objectives within the admitted 1% scale window.
        return ((row_quality(plan)[:2], vertical_row_score(counts, rhythm)) if rhythm != "auto" else (row_quality(plan), row_rhythm_cost(counts, rhythm))) + (bad, bad - good,
                symmetry, round(minority_center, 8), -vertical, round(head, 9),
                round(composition_color_cost(plan,by_id,color_mode,color_distances),9), -plan["commonScale"])
    def score_key(plan):
        if "_score" not in plan: plan["_score"] = score(plan)
        return plan["_score"]
    @lru_cache(maxsize=2048)
    def tokens(m, f):
        size = m + f
        if abs(m - f) <= 1:
            start = "M" if m >= f else "F"
            return tuple(start if i % 2 == 0 else ("F" if start == "M" else "M") for i in range(size))
        small, minority = min(m, f), "M" if m < f else "F"
        majority = "F" if minority == "M" else "M"
        @lru_cache(maxsize=None)
        def rec(depth, left, outer_l, outer_r):
            check()
            length = size - 2 * depth
            if left < 0 or left > length: return None
            if length == 0: return (int(outer_l == outer_r), 0, 0.0, ())
            if length == 1:
                t = minority if left else majority
                return (int(outer_l == t) + int(outer_r == t), 0, 0.0, (t,))
            best = None
            for a, b in itertools.product((0, 1), repeat=2):
                l, r = minority if a else majority, minority if b else majority
                inner = rec(depth + 1, left - a - b, l, r)
                if inner is None: continue
                value = (inner[0] + int(outer_l == l) + int(outer_r == r), inner[1] + int(l != r), inner[2] + (a + b) * ((size - 1) / 2 - depth) ** 2, (l,) + inner[3] + (r,))
                if best is None or value[:3] < best[:3]: best = value
            return best
        return rec(0, small, "", "")[3]
    @lru_cache(maxsize=128)
    def gender_templates(counts, rank):
        subset = [i for i in by_id.values() if i["priority"] == rank]
        male = sum(i["gender"] == "M" for i in subset)
        female = sum(i["gender"] == "F" for i in subset)
        if male + female != len(subset):
            # Unknowns remain neutral. The swap search can improve this seed.
            pool = {s: sum(i["gender"] == s for i in subset) for s in ("M", "F", "U")}
            result = []
            for r, count in enumerate(counts):
                row = []
                for c in range(count):
                    wanted = "M" if (r + c) % 2 == 0 else "F"
                    sex = wanted if pool[wanted] else "U" if pool["U"] else "F" if pool["F"] else "M"
                    row.append(sex); pool[sex] -= 1
                result.append(tuple(row))
            return tuple(result)
        prefix = [0]
        for count in counts: prefix.append(prefix[-1] + count)
        @lru_cache(maxsize=None)
        def rec(r, used):
            check()
            if r == len(counts): return (0, 0, 0.0, ()) if used == male else None
            count = counts[r]; best = None
            for m in range(max(0, count - (female - (prefix[r] - used))), min(count, male - used) + 1):
                f = count - m; row = tokens(m, f); tail = rec(r + 1, used + m)
                if tail is None: continue
                sym = sum(a != b for a, b in zip(row[:count//2], reversed(row))) if m and f and abs(m-f)>1 else 0
                minority = "M" if m < f else "F"
                cent = sum((i - (count-1)/2)**2 for i,s in enumerate(row) if s==minority) if m and f and abs(m-f)>1 else 0
                value = (tail[0] + max(0, abs(m-f)-1), tail[1] + sym, tail[2] + cent, (row,) + tail[3])
                if best is None or value[:3] < best[:3]: best = value
            return best
        return rec(0, 0)[3]
    def assign(rows, reverse=False, color_seed=False):
        raw = reflow(rows)
        if raw is None: return None
        position = {p["id"]: p["centerX"] for p in raw["placements"]}
        templates = [[None] * len(ids) for _,ids in rows]
        for rank in sorted({i["priority"] for i in by_id.values()}):
            segments = [(r, [c for c,id_ in enumerate(ids) if by_id[id_]["priority"] == rank]) for r,(_,ids) in enumerate(rows)]
            segments = [(r,cols) for r,cols in segments if cols]
            counts = tuple(len(cols) for _,cols in segments)
            tokens_ = gender_templates(counts,rank) if use_gender else tuple(tuple("A" for _ in cols) for _,cols in segments)
            for (r,cols),template in zip(segments,tokens_):
                if reverse and r % 2: template = tuple(reversed(template))
                for c,sex in zip(cols,template): templates[r][c] = sex
        pools, slots = {}, {}
        for item in by_id.values(): pools.setdefault((item["priority"], item["gender"] if use_gender else "A"), []).append(item)
        result = [(zi, [None] * len(ids)) for zi, ids in rows]
        for r, ((_, ids), template) in enumerate(zip(rows, templates)):
            for c, (id_, sex) in enumerate(zip(ids, template)):
                slots.setdefault((by_id[id_]["priority"],sex), []).append((position[id_], r, c))
        for sex, pool in pools.items():
            if use_head:
                pool.sort(key=lambda i: (-(i["headTurn"] / 80 + (.15 * i["headLeanWeight"] * i["headLean"] / 30 if i.get("headLeanValid", False) else 0)) if i.get("headTurnValid", False) else 0, i["order"]))
                targets = sorted(slots[sex])
            else: targets = slots[sex]
            if color_seed:
                # Preserve the pose seed: colour orders only equal-pose buckets.
                # The full candidate is still judged with the global objective.
                buckets = {}
                for index,item in enumerate(pool):
                    if not item.get("colorPalette"): continue
                    pose = (item.get("headTurnValid",False),item["headTurn"],item.get("headLeanValid",False),item["headLean"],item["headLeanWeight"]) if use_head else ()
                    buckets.setdefault(pose,[]).append(index)
                for indices in buckets.values():
                    ordered = sorted((pool[i] for i in indices),key=lambda i:(-sum(p["weight"]*p["lab"][0] for p in i["colorPalette"]),i["order"]))
                    if color_mode == "contrast":
                        alternating=[]
                        while ordered:
                            alternating.append(ordered.pop(0))
                            if ordered:alternating.append(ordered.pop())
                        ordered=alternating
                    for index,item in zip(indices,ordered):pool[index]=item
            for item, (_,r,c) in zip(pool, targets): result[r][1][c] = item["id"]
        return result
    def row_quality(plan):
        groups = {}
        for row in plan["rows"]: groups.setdefault(row["zoneIndex"], []).append(len(row["ids"]))
        singletons = excess = 0
        imbalance = 0.0
        for counts in groups.values():
            if len(counts) > 1:
                singletons += sum(c == 1 for c in counts)
                excess += max(0, max(counts) - min(counts) - 2)
                imbalance += sum(c * c for c in counts) - sum(counts) ** 2 / len(counts)
        return singletons, excess, round(imbalance, 8)
    baseline_quality = row_quality(baseline)
    # All candidates are complete plans. The geometric incumbent is always kept.
    candidates = [baseline]; best_scale = baseline.get("referenceScale", baseline["commonScale"]); evaluated = 0
    skeletons, seen = [], set()
    def add_skeleton(rows):
        if len({i["priority"] for i in by_id.values()}) > 1:
            ordered = sorted((id_ for _,ids in rows for id_ in ids), key=lambda id_: by_id[id_]["priority"])
            offset = 0; ranked_rows = []
            for zi,ids in rows:
                ranked_rows.append((zi,ordered[offset:offset+len(ids)])); offset += len(ids)
            rows = ranked_rows
        key = tuple((zi, len(ids)) for zi, ids in rows)
        if key not in seen and len(skeletons) < 96:
            seen.add(key); skeletons.append([(zi, list(ids)) for zi, ids in rows])
    def consider(rows):
        nonlocal best_scale, evaluated, candidates
        check(); evaluated += 1
        plan = reflow(rows)
        if plan is None: return None
        quality = row_quality(plan)
        if quality[0] > baseline_quality[0] or quality[1] > baseline_quality[1]: return None
        if plan["commonScale"] < best_scale * (1 - scale_loss_limit) - 1e-9: return None
        plan["_score"] = score(plan)
        best_scale = max(best_scale, plan["commonScale"])
        candidates = [p for p in candidates if p["commonScale"] >= best_scale * (1 - scale_loss_limit) - 1e-9]
        candidates.append(plan)
        # Limit retained data, always preserving the largest geometric candidate.
        if len(candidates) > 16:
            largest = max(candidates, key=lambda p:p["commonScale"])
            candidates = sorted(candidates, key=score_key)[:15]
            if not any(p is largest for p in candidates): candidates.append(largest)
        return plan
    add_skeleton([(r["zoneIndex"], r["ids"]) for r in baseline["rows"]])
    seed = payload.get("seedRows")
    exhausted = False
    try:
        if seed is not None:
            if not isinstance(seed, list) or any(not isinstance(r, dict) or not isinstance(r.get("ids"), list) for r in seed):
                raise ValueError("Invalid composition seed")
            seed_rows = [(r.get("zoneIndex"), r["ids"]) for r in seed]
            plan = consider(seed_rows)
            if plan: add_skeleton(seed_rows)
        # Explore topology as well as ordering: row count changes and transfers
        # of one/two photos between any rows or zones, up to two neighbourhoods.
        cursor = 0
        while cursor < min(24, len(skeletons)):
            check(); rows = skeletons[cursor]; cursor += 1
            for a, (zi, ids) in enumerate(rows):
                if not desired and len(ids) > 1:
                    k = len(ids)//2; add_skeleton(rows[:a] + [(zi, ids[:k]), (zi, ids[k:])] + rows[a+1:])
                if not desired and a+1 < len(rows) and rows[a+1][0] == zi:
                    add_skeleton(rows[:a] + [(zi, ids + rows[a+1][1])] + rows[a+2:])
                for b in range(len(rows)):
                    if a == b: continue
                    for amount in (1,2):
                        if len(ids) <= amount: continue
                        trial = [(z,list(v)) for z,v in rows]
                        moved = trial[a][1][-amount:]; del trial[a][1][-amount:]; trial[b][1].extend(moved)
                        add_skeleton(trial)
            # Fairness: evaluate each topology while expanding; never spend the
            # full budget building a queue before trying semantic assignments.
            for trial in (rows, assign(rows), assign(rows, True), assign(rows, color_seed=True) if color_mode != "off" else None):
                if trial: consider(trial)
        for rows in skeletons[cursor:]:
            check()
            for trial in (rows, assign(rows), assign(rows, True), assign(rows, color_seed=True) if color_mode != "off" else None):
                if trial: consider(trial)
        # Improve complete shortlisted plans with global pair exchanges.
        for initial in sorted(candidates, key=score_key)[:3]:
            rows = [(r["zoneIndex"], list(r["ids"])) for r in initial["rows"]]
            current = initial; slots = [(r,c) for r,(_,ids) in enumerate(rows) for c in range(len(ids))]
            for _ in range(3):
                changed = False
                for ai, (ra,ca) in enumerate(slots):
                    check()
                    for rb,cb in slots[ai+1:]:
                        ia,ib=by_id[rows[ra][1][ca]],by_id[rows[rb][1][cb]]
                        if ia["priority"] != ib["priority"]: continue
                        if color_mode == "off" and not use_head and (not use_gender or ia["gender"] == ib["gender"]): continue
                        rows[ra][1][ca],rows[rb][1][cb]=ib["id"],ia["id"]
                        trial=consider(rows)
                        if trial and trial["_score"] < score_key(current):
                            current=trial;changed=True
                        else: rows[ra][1][ca],rows[rb][1][cb]=ia["id"],ib["id"]
                if not changed: break
    except TimeoutError:
        exhausted = True
    eligible = [p for p in candidates if p["commonScale"] >= best_scale * (1 - scale_loss_limit) - 1e-9]
    best = min(eligible, key=score_key)
    best = {k:v for k,v in best.items() if k != "_score"}
    best.update(compositionSearch=True, referenceScale=best_scale, maxScaleLoss=scale_loss_limit,
                compositionEvaluated=evaluated, compositionTopologies=len(skeletons), compositionScore=list(score(best)[2:8]), compositionColorCost=composition_color_cost(best,by_id,color_mode,color_distances),
                budgetExhausted=exhausted or baseline.get("budgetExhausted",False),
                geometryBaseline={k:v for k,v in baseline.items() if k != "_score"}, elapsed=round(time.monotonic()-started,3))
    return best


def register_active_request(request_id):
    state = {"cancel": threading.Event(), "last_heartbeat": time.monotonic()}
    with active_requests_lock:
        if request_id in active_requests:
            raise ValueError("Duplicate active request ID")
        active_requests[request_id] = state
    return state


def unregister_active_request(request_id):
    with active_requests_lock:
        active_requests.pop(request_id, None)


def heartbeat_request(request_id):
    with active_requests_lock:
        state = active_requests.get(request_id)
        if state is None:
            return False
        state["last_heartbeat"] = time.monotonic()
        return True


def cancel_request(request_id):
    with active_requests_lock:
        state = active_requests.get(request_id)
        if state is None:
            return False
        state["cancel"].set()
        return True


def request_server_shutdown():
    shutdown_event.set()
    with active_requests_lock:
        states = list(active_requests.values())
    for state in states:
        state["cancel"].set()


def request_cancelled(state):
    if state["cancel"].is_set():
        return True
    if time.monotonic() - state["last_heartbeat"] > REQUEST_HEARTBEAT_TIMEOUT:
        state["cancel"].set()
        return True
    return False


def cancellation_watchdog():
    while True:
        now = time.monotonic()
        with active_requests_lock:
            states = list(active_requests.values())
        for state in states:
            if now - state["last_heartbeat"] > REQUEST_HEARTBEAT_TIMEOUT:
                state["cancel"].set()
        time.sleep(0.25)


def queue_preview_cleanup(path):
    if not isinstance(path, str):
        return False
    path = os.path.abspath(path)
    if (os.path.normcase(os.path.realpath(os.path.dirname(path))) !=
            os.path.normcase(os.path.realpath(tempfile.gettempdir()))):
        return False
    if not re.fullmatch(r"ALG_\d+_\d+_\d+\.jpg", os.path.basename(path), re.IGNORECASE):
        return False
    with cleanup_lock:
        pending_cleanup.add(path)
    flush_preview_cleanup()
    return True


def flush_preview_cleanup():
    if not request_lock.acquire(False):
        return
    try:
        with cleanup_lock:
            for path in list(pending_cleanup):
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
                except OSError:
                    continue
                pending_cleanup.discard(path)
    finally:
        request_lock.release()


def receive_json(client):
    data = bytearray()
    while len(data) < 1024 * 1024:
        block = client.recv(4096)
        if not block:
            break
        data.extend(block)
        if b"\n" in data:
            break
    return json.loads(bytes(data).decode("utf-8"))


def send_data_to_jsx(obj):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect((API_HOST, API_PORT_SEND))
        connection.sendall((json.dumps(obj, ensure_ascii=True, allow_nan=False) + "\n").encode("ascii"))


def log_gender_result(layer_name, answer, request_id, method):
    # Structured single-line records retain source/confidence also for uncertain
    # results. Called once per analyzed layer, never inside inference loops.
    logging.info("gender_result %s", json.dumps({
        "request_id": request_id,
        "id": answer.get("id"),
        "name": layer_name,
        "sex": answer.get("sex"),
        "source": answer.get("source"),
        "method": method,
        "confidence": answer.get("confidence"),
        "analysis_status": answer.get("analysis_status"),
        "reason": answer.get("reason"),
    }, ensure_ascii=False, allow_nan=False))


def handle_client(client_socket):
    global last_request_time
    request_id = None

    def reply(kind, message):
        send_data_to_jsx({
            "type": kind,
            "message": message,
            "request_id": request_id,
            "server_id": SERVER_ID,
        })

    try:
        with client_socket:
            client_socket.settimeout(5)
            message = receive_json(client_socket)
            kind = message.get("type")

            if kind == "heartbeat":
                heartbeat_request(message.get("target_id"))
                last_request_time = time.monotonic()
                return
            if kind == "cancel":
                stopped = cancel_request(message.get("target_id"))
                last_request_time = time.monotonic()
                client_socket.sendall((json.dumps({"stopped": bool(stopped)}) + "\n").encode("ascii"))
                return
            if kind == "shutdown":
                request_server_shutdown()
                last_request_time = time.monotonic()
                client_socket.sendall((json.dumps({"stopped": True, "server_id": SERVER_ID}) + "\n").encode("ascii"))
                return

        request_id = message.get("request_id")
        last_request_time = time.monotonic()

        if kind == "handshake":
            reply("answer", SERVER_ID)
            return
        if kind == "cleanup":
            reply("answer", queue_preview_cleanup(message.get("message")))
            return
        if kind in ("alphabet_names", "gender_names"):
            rows = message.get("message")
            alphabetical = kind == "alphabet_names"
            if alphabetical and (not isinstance(rows, list) or not 1 <= len(rows) <= 500):
                raise ValueError("alphabet_names payload must contain 1..500 entries")
            if not isinstance(rows, list):
                raise ValueError("gender_names payload must be a list")
            state = register_active_request(request_id)
            try:
                result, seen = [], set()
                for row in rows:
                    if request_cancelled(state):
                        reply("cancelled", "Operation cancelled")
                        return
                    if alphabetical:
                        if (not isinstance(row, dict) or type(row.get("id")) is not int or
                                row["id"] in seen or not isinstance(row.get("name"), str) or len(row["name"]) > 4096):
                            raise ValueError("Invalid alphabetical name entry")
                        seen.add(row["id"])
                        answer = dict(id=row["id"], **alphabetical_name_key(row["name"]))
                    else:
                        if not isinstance(row, dict):
                            raise ValueError("gender_names entries must be objects")
                        answer = classify_name(row.get("name", ""))
                        answer["id"] = row.get("id")
                        log_gender_result(row.get("name", ""), answer, request_id, "name")
                    result.append(answer)
                if request_cancelled(state):
                    reply("cancelled", "Operation cancelled")
                else:
                    reply("answer", result)
            finally:
                unregister_active_request(request_id)
                last_request_time = time.monotonic()
            return
        if kind in ("layout_zones", "layout_composition", "analyze_image"):
            state = register_active_request(request_id)
            if not request_lock.acquire(False):
                unregister_active_request(request_id)
                reply("error", "Analysis is busy; wait for the previous request to finish.")
                return
            try:
                if kind == "analyze_image":
                    if request_cancelled(state):
                        reply("cancelled", "Operation cancelled")
                        return
                    payload = message.get("message") or {}
                    if not isinstance(payload, dict):
                        raise ValueError(kind + " payload must be an object")
                    answer = analyze_photo(payload, state)
                    if answer.get("gender"):
                        answer["gender"]["id"] = payload.get("id")
                        log_gender_result(payload.get("name", ""), answer["gender"], request_id, "image")
                    if answer.get("color"):
                        logging.info("color_result %s", json.dumps(dict(request_id=request_id,
                            id=payload.get("id"), **answer["color"]), ensure_ascii=False, allow_nan=False))
                    if answer.get("head_turn"):
                        logging.info("head_turn_result %s", json.dumps(dict(
                            request_id=request_id, id=payload.get("id"), name=payload.get("name", ""),
                            **answer["head_turn"]), ensure_ascii=False, allow_nan=False))
                else:
                    solver = calculate_composition_layout if kind == "layout_composition" else calculate_zone_layout
                    answer = solver(message.get("message"), state)
                if request_cancelled(state):
                    reply("cancelled", "Operation cancelled")
                else:
                    reply("answer", answer)
            except InterruptedError:
                if kind == "analyze_image":
                    raise
                reply("cancelled", "Operation cancelled")
            finally:
                unregister_active_request(request_id)
                last_request_time = time.monotonic()
                request_lock.release()
                flush_preview_cleanup()
            return

        reply("error", "Unknown request")
    except Exception as exc:
        logging.exception("Request failed")
        try:
            reply("error", str(exc))
        except Exception:
            pass


UPDATE_INTERVAL = 24 * 60 * 60
UPDATE_IDLE = 15
UPDATE_LIMIT = 1048576
pending_update = None


def read_update_json(path):
    try:
        with open(path, "rb") as stream:
            data = stream.read(UPDATE_LIMIT + 1)
        if len(data) > UPDATE_LIMIT:
            return None
        value = json.loads(data.decode("utf-8-sig"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, UnicodeError):
        return None


def write_update_json(path, value):
    temporary = path + ".tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
        os.replace(temporary, path)
    finally:
        try:
            os.remove(temporary)
        except OSError:
            pass


def updates_allowed(folder):
    settings = read_update_json(os.path.join(folder, "settings.json"))
    # Missing or partially written preferences are retried on the next idle tick.
    if not settings or settings.get("disabled") is not False or settings.get("enabled") is not True or settings.get("busy") is not False:
        return False
    updated = settings.get("updated")
    if not isinstance(updated, (int, float)) or not math.isfinite(updated):
        return False
    age = time.time() - updated / 1000
    if 0 <= age < UPDATE_IDLE:
        return False
    with active_requests_lock:
        if active_requests:
            return False
    return not request_lock.locked() and time.monotonic() - last_request_time >= UPDATE_IDLE


def check_release_in_background(folder):
    global pending_update
    if not updates_allowed(folder) or shutdown_event.is_set():
        return
    if pending_update is not None:
        write_update_json(os.path.join(folder, "release.json"), pending_update)
        pending_update = None
    stamp = os.path.join(folder, "checked.json")
    previous = (read_update_json(stamp) or {}).get("checked", 0)
    now = time.time()
    if isinstance(previous, (int, float)) and math.isfinite(previous) and 0 <= now - previous < UPDATE_INTERVAL:
        return
    # Failed requests also observe the daily limit; no repeated network retries.
    write_update_json(stamp, {"checked": now})
    request = urllib.request.Request(
        "https://api.github.com/repos/boogalooper/Auto-layout/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Auto-layout-update-check"})
    with urllib.request.urlopen(request, timeout=8) as response:
        data = response.read(UPDATE_LIMIT + 1)
    if len(data) > UPDATE_LIMIT:
        return
    release = json.loads(data.decode("utf-8"))
    if (not isinstance(release, dict) or release.get("draft") is not False or
            release.get("prerelease") is not False or
            not isinstance(release.get("tag_name"), str) or
            not re.fullmatch(r"v?\d+(?:\.\d+)*", release["tag_name"])):
        return
    body = release.get("body")
    pending_update = dict(tag_name=release["tag_name"], body=body if isinstance(body, str) else "",
                    draft=False, prerelease=False)
    # A new layout or opt-out may have arrived while the network request ran.
    if updates_allowed(folder) and not shutdown_event.is_set():
        write_update_json(os.path.join(folder, "release.json"), pending_update)
        pending_update = None


def update_worker():
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        return
    folder = os.path.join(local, "JazzyScripts", "AutoLayoutUpdates")
    while not shutdown_event.wait(5):
        try:
            check_release_in_background(folder)
        except Exception:
            # Updates never affect analysis or produce user-facing errors.
            pass


def start_server():
    global last_request_time
    last_request_time = time.monotonic()
    threading.Thread(target=cancellation_watchdog, daemon=True).start()
    threading.Thread(target=update_worker, daemon=True, name="auto-layout-updates").start()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            server.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        server.bind((API_HOST, API_PORT_LISTEN))
        server.listen(8)
        server.settimeout(0.5)
        while True:
            try:
                client, _ = server.accept()
                threading.Thread(target=handle_client, args=(client,), daemon=True).start()
            except socket.timeout:
                flush_preview_cleanup()

            if shutdown_event.is_set():
                if not request_lock.locked():
                    break
                continue

            with active_requests_lock:
                has_active_requests = bool(active_requests)
            if not has_active_requests and not request_lock.locked() and time.monotonic() - last_request_time > TIMEOUT:
                shutdown_event.set()
                break


def self_test():
    # Instantiate dictionaries and models without requiring a test photograph.
    store = get_russian_names()
    if store is None:
        raise RuntimeError("russiannames data unavailable; run install_runtime.bat")
    if classify_name("Ахмедова Амина").get("sex") != "F" or classify_name("Молодцов Константин").get("sex") != "M":
        raise RuntimeError("russiannames identity self-test failed")
    analyzer = get_morph()
    if analyzer is None or not analyzer.parse("Иван"):
        raise RuntimeError("pymorphy3 initialization failed")
    detector = get_face_detector()
    net = get_gender_net()
    if detector is None or net is None:
        raise RuntimeError("model initialization failed")
    dummy = np.zeros((224, 224, 3), np.uint8)
    dummy_rgb = cv2.cvtColor(dummy, cv2.COLOR_BGR2RGB)
    blob = cv2.dnn.blobFromImage(dummy_rgb, 1.0, (224, 224), (104.0, 117.0, 123.0), swapRB=False, crop=False)
    with gender_net_lock:
        net.setInput(blob)
        out = net.forward()
    if binary_probabilities(out) is None:
        raise RuntimeError("gender model output is invalid")
    landmarker = get_head_landmarker()
    import mediapipe as mp
    with head_landmarker_lock:
        landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=dummy_rgb))
    body_landmarker = get_body_landmarker()
    with body_landmarker_lock:
        body_landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=dummy_rgb))
    print("Auto Layout runtime: morphology, face/gender models and head/body landmarks OK")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        log_dir = os.path.dirname(sys.prefix)
        os.makedirs(log_dir, exist_ok=True)
        logging.basicConfig(
            handlers=[RotatingFileHandler(os.path.join(log_dir, "server.log"), maxBytes=1000000, backupCount=2, encoding="utf-8")],
            level=logging.INFO,
        )
        if sys.stdout is None:
            sys.stdout = open(os.devnull, "w")
        if sys.stderr is None:
            sys.stderr = open(os.devnull, "w")
        try:
            start_server()
        except OSError:
            logging.exception("Server could not bind its dedicated port")
        finally:
            analysis_pool.shutdown(wait=True)
            with russian_names_lock:
                if russian_names_store is not None:
                    russian_names_store.close()
