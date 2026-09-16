// Web Worker entry for the git engine (T3.5): comlink exposes one EngineApi per worker.
import "./bufferPolyfill";
import * as Comlink from "comlink";
import { createEngineApi } from "./workerApi";

Comlink.expose(createEngineApi());
