"use strict";import{WebRtcTransport as e}from"@hyperttp/transport-webrtc/browser";export{WebRtcTransport}from"@hyperttp/transport-webrtc/browser";export function createBrowserWebRtcAudio(o={}){const r=new e(o);let t;return{transport:r,close(){return t??=r.close(),t}}}
//# sourceMappingURL=browser.js.map
