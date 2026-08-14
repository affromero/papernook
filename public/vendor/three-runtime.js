import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Generated scenes run as classic inline scripts for Safari compatibility.
// Expose only the already-approved, locally vendored dependencies.
globalThis.THREE = THREE;
globalThis.OrbitControls = OrbitControls;
globalThis.papernookThreeRuntimeReady = true;
globalThis.dispatchEvent(new Event("papernook-three-runtime-ready"));
