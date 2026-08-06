#!/usr/bin/env python3
"""
wake-word/listen.py

Escucha audio crudo por stdin (16kHz, mono, Int16) y avisa por stdout
cuando reconoce la wake word — una línea JSON por detección:
    {"event": "wake"}

No sabe nada de LiveKit ni de Node — lib/wake-word.js lo arranca como
proceso hijo y le manda el audio por stdin. Es el mismo patrón que este
repo ya usa con arecord/aplay (ver lib/livekit-session.js): un proceso
chico, se le escribe por stdin, se le lee stdout.

Variables de entorno (ver .env.example):
    WAKE_WORD_MODEL_PATH   ruta al modelo entrenado (.onnx o .tflite)
    WAKE_WORD_FRAMEWORK    "onnx" o "tflite" (default: onnx)
    WAKE_WORD_THRESHOLD    0–1, confianza mínima para disparar (default: 0.5)

Uso manual (con el venv activado):
    python wake-word/listen.py
"""

import sys
import os
import json
import numpy as np
from openwakeword.model import Model

CHUNK_SAMPLES = 1280  # 80ms a 16kHz — tamaño de frame recomendado por openWakeWord
DEBOUNCE_SEC  = 2.0    # evita avisar la misma detección varias veces seguidas


def load_model():
    model_path = os.environ.get("WAKE_WORD_MODEL_PATH")
    if not model_path:
        print("falta WAKE_WORD_MODEL_PATH", file=sys.stderr, flush=True)
        sys.exit(1)

    framework = os.environ.get("WAKE_WORD_FRAMEWORK", "onnx")
    model = Model(wakeword_models=[model_path], inference_framework=framework)

    # Solo cargamos un modelo (el de la wake word), así que es el único nombre
    # que puede devolver predict() — no hace falta pisar nada más.
    wakeword_name = list(model.models.keys())[0]
    return model, wakeword_name


def listen(model, wakeword_name):
    threshold = float(os.environ.get("WAKE_WORD_THRESHOLD", "0.5"))
    stdin     = sys.stdin.buffer

    while True:
        raw = stdin.read(CHUNK_SAMPLES * 2)  # 2 bytes por sample (Int16)
        if len(raw) < CHUNK_SAMPLES * 2:
            break  # Node cerró el pipe

        audio  = np.frombuffer(raw, dtype=np.int16)
        # threshold/debounce_time acá SOLO evitan que una misma detección
        # dispare de nuevo mientras sigue "caliente" — NO filtran el ruido
        # de fondo. El score real (0-1, casi siempre un numerito bajo tipo
        # 0.02 con silencio/ruido) hay que compararlo contra el umbral
        # nosotros mismos, por eso el "if" de abajo.
        scores = model.predict(
            audio,
            threshold=({wakeword_name: threshold}),
            debounce_time=DEBOUNCE_SEC,
        )

        # DEBUG temporal — mostrar el score real ayuda a saber si el modelo
        # está "cerca" de disparar o si el audio no le está llegando bien.
        if os.environ.get("WAKE_WORD_DEBUG"):
            print(f"score={scores[wakeword_name]:.3f}", file=sys.stderr, flush=True)

        if scores[wakeword_name] >= threshold:
            print(json.dumps({"event": "wake"}), flush=True)


def main():
    model, wakeword_name = load_model()
    print(f"listo - escuchando \"{wakeword_name}\"", file=sys.stderr, flush=True)
    listen(model, wakeword_name)


if __name__ == "__main__":
    main()
