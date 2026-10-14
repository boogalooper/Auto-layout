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
SERVER_ID = "auto-layout/0.10.14"
TIMEOUT = 15 * 60
REQUEST_HEARTBEAT_TIMEOUT = 4.0

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


def classify_image(image_path):
    img = read_image(image_path)
    if img is None:
        return {
            "sex": "U", "confidence": 0.0, "source": "unknown",
            "reason": "image_read_failed", "needs_image": False,
            "analysis_status": "technical_failure",
        }

    selected, reason = choose_face(img)
    if selected is None:
        return {
            "sex": "U", "confidence": 0.0, "source": "unknown",
            "reason": reason, "needs_image": False,
            "analysis_status": "not_applicable",
        }

    face_crop, face_score = selected
    return classify_gender_crop(face_crop, face_score)


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


def classify_gender(layer_name, image_path=None):
    by_name = classify_name(layer_name)
    if by_name["sex"] != "U":
        return by_name
    if image_path:
        return classify_image(image_path)
    return by_name


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


def balanced_zone_counts(order, width, height, row_count, scale, gx, gy, check):
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
    states = {0: [(0.0, (0, 0, 0.0), [])]}
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
                             old_score[2] + count * (r - center) ** 2)
                    out = next_states.setdefault(end, [])
                    if any(fh <= h + 1e-9 and fs <= score for fh, fs, fc in out): continue
                    out[:] = [(fh, fs, fc) for fh, fs, fc in out if not (h <= fh + 1e-9 and score <= fs)]
                    out.append((h, score, old_counts + [count]))
        states = next_states
    feasible = states.get(n)
    return min(feasible, key=lambda x: x[1])[2] if feasible else None


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
    items, zones = payload.get("items"), payload.get("zones")
    if not isinstance(items, list) or not 1 <= len(items) <= 500 or not isinstance(zones, list) or not 1 <= len(zones) <= 128:
        raise ValueError("Unsupported item/zone count")
    items = [dict(id=item["id"], width=number(item["width"], True), height=number(item["height"], True)) for item in items]
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
        if rhythm == "auto" or len(counts) <= 1 or max(counts) == min(counts):
            return 0.0
        low, span = min(counts), max(counts) - min(counts)
        size = len(counts)
        def profile(i):
            if rhythm == "alternateWide": return 1 if i % 2 == 0 else 0
            if rhythm == "alternateNarrow": return 0 if i % 2 == 0 else 1
            middle = (size - 1) / 2
            minimum = 0 if size % 2 else .5
            span_ = middle - minimum
            center = 1 - (abs(i - middle) - minimum) / span_ if span_ > 0 else 1
            return center if rhythm == "centerWide" else 1 - center
        return sum(((v - low) / span - profile(i)) ** 2 for i, v in enumerate(counts)) / size
    def search(order, scale, metrics, area_prefix):
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
            for (start, row_key, mask), (penalty, assignments, counts) in states.items():
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
        candidate = sorted(items, key=key)
        if [i["id"] for i in candidate] not in [[i["id"] for i in order] for order in orders]: orders.append(candidate)
    if n <= 6:
        signatures = {tuple((i["width"], i["height"]) for i in order) for order in orders}
        for candidate in itertools.permutations(items):
            signature = tuple((i["width"], i["height"]) for i in candidate)
            if signature not in signatures:
                signatures.add(signature)
                orders.append(list(candidate))
    else:
        for candidate in (sorted(items, key=lambda i: (i["height"], i["width"], i["id"])),
                          sorted(items, key=lambda i: (-i["width"] * i["height"], i["id"]))):
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
            high = min(max(z["width"] for z in zones) / max(i["width"] for i in order),
                       max(z["height"] for z in zones) / max(i["height"] for i in order))
            low = 0.0
            # Subsequent orders first prove that they improve the current scale.
            if best:
                probe = search(order, best[0], metrics, area_prefix); tested += 1
                if probe is None: continue
                low = best[0]
            for _ in range(20 if order_index == 0 else 16):
                check()
                scale = (low + high) / 2
                allocation = search(order, scale, metrics, area_prefix); tested += 1
                if allocation is None: high = scale
                else:
                    low = max(scale, exact_scale(allocation, metrics))
                    if best is None or low > best[0] + 1e-10 or (abs(low - best[0]) <= 1e-10 and (allocation[0], rhythm_cost(allocation[2]), len(allocation[2])) < (best[2][0], rhythm_cost(best[2][2]), len(best[2][2]))):
                        best = (low, order, allocation, metrics)
    except TimeoutError:
        budget_exhausted = True
    if best is None:
        return dict(status="fallback", reason="No complete layout within search budget", tested=tested)
    scale, order, allocation, metrics = best
    row_specs = []
    # Balance only the winning complete allocation, at the same scale. A small
    # separate bounded budget avoids losing that valid incumbent at the deadline.
    balance_deadline = time.monotonic() + 3.0
    def balance_check():
        if request_cancelled(state): raise InterruptedError("Layout cancelled")
        if time.monotonic() > balance_deadline: raise TimeoutError("Row balancing budget exhausted")
    for zi, start, counts in allocation[1]:
        if counts:
            zone = zones[zi]
            try:
                improved = balanced_zone_counts(order[start:start + sum(counts)], zone["width"], zone["height"],
                                                len(counts), scale, gx, gy, balance_check)
                if improved: counts = improved
            except TimeoutError:
                budget_exhausted = True
        for count in counts:
            width, height = metrics[start][count]
            row_specs.append(dict(zoneIndex=zi, ids=[i["id"] for i in order[start:start + count]], contentWidth=width, rowHeight=height))
            start += count
    gap_y = gy * scale * multiplier
    has_vertical = False
    for z in zones:
        rows = [r for r in row_specs if r["zoneIndex"] == z["index"]]
        if len(rows) > 1:
            has_vertical = True
            gap_y = min(gap_y, (z["height"] - sum(r["rowHeight"] for r in rows) * scale) / (len(rows) - 1))
    gap_y = max(gy * scale, gap_y) if has_vertical else 0.0
    gaps = {}
    uniform_gap = gx * scale * multiplier
    for row in row_specs:
        count = len(row["ids"])
        if count > 1:
            limit = (zones[row["zoneIndex"]]["width"] - row["contentWidth"] * scale) / (count - 1)
            uniform_gap = min(uniform_gap, limit)
            gaps[count] = min(gaps.get(count, math.inf), limit)
    uniform_gap = max(gx * scale, uniform_gap)
    placements = []
    by_id = {i["id"]: i for i in order}
    for z in zones:
        rows = [r for r in row_specs if r["zoneIndex"] == z["index"]]
        height = sum(r["rowHeight"] for r in rows) * scale + max(0, len(rows) - 1) * gap_y
        top = z["top"] + (z["height"] - height) / 2
        for row in rows:
            count = len(row["ids"])
            gap_x = gaps.get(count, 0.0) if align == "justify" else uniform_gap if count > 1 else 0.0
            width = row["contentWidth"] * scale + max(0, count - 1) * gap_x
            x = z["left"] if align == "left" else z["right"] - width if align == "right" else z["left"] + (z["width"] - width) / 2
            row.update(top=top, gapX=gap_x)
            for id_ in row["ids"]:
                item = by_id[id_]
                placements.append(dict(id=id_, centerX=x + item["width"] * scale / 2,
                                       centerY=top + item["height"] * scale / 2, scale=scale))
                x += item["width"] * scale + gap_x
            top += row["rowHeight"] * scale + gap_y
    return dict(status="ok", commonScale=scale, gapY=gap_y, rows=row_specs, placements=placements,
                tested=tested, orders=len(orders), searchSteps=steps, exhaustiveOrders=n <= 6, budgetExhausted=budget_exhausted,
                elapsed=round(time.monotonic() - started, 3))


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
        if kind == "gender_names":
            rows = message.get("message")
            if not isinstance(rows, list):
                raise ValueError("gender_names payload must be a list")
            state = register_active_request(request_id)
            try:
                result = []
                for row in rows:
                    if request_cancelled(state):
                        reply("cancelled", "Operation cancelled")
                        return
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
        if kind == "layout_zones":
            state = register_active_request(request_id)
            if not request_lock.acquire(False):
                unregister_active_request(request_id)
                reply("error", "Analysis is busy; wait for the previous request to finish.")
                return
            try:
                answer = calculate_zone_layout(message.get("message"), state)
                if request_cancelled(state):
                    reply("cancelled", "Operation cancelled")
                else:
                    reply("answer", answer)
            except InterruptedError:
                reply("cancelled", "Operation cancelled")
            finally:
                unregister_active_request(request_id)
                last_request_time = time.monotonic()
                request_lock.release()
                flush_preview_cleanup()
            return
        if kind in ("gender_image", "analyze_image"):
            state = register_active_request(request_id)
            if not request_lock.acquire(False):
                unregister_active_request(request_id)
                reply("error", "Analysis is busy; wait for the previous request to finish.")
                return
            try:
                if request_cancelled(state):
                    reply("cancelled", "Operation cancelled")
                    return
                payload = message.get("message") or {}
                if not isinstance(payload, dict):
                    raise ValueError(kind + " payload must be an object")
                if kind == "analyze_image":
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
                    answer = classify_gender(payload.get("name", ""), payload.get("path"))
                    answer["id"] = payload.get("id")
                    log_gender_result(payload.get("name", ""), answer, request_id, "image")
                if request_cancelled(state):
                    reply("cancelled", "Operation cancelled")
                else:
                    reply("answer", answer)
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


def start_server():
    global last_request_time
    last_request_time = time.monotonic()
    threading.Thread(target=cancellation_watchdog, daemon=True).start()
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
