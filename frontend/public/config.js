// Default configuration, overwritten by the container entrypoint at start-up.
//
// Same-origin by default: a deployment that puts the consoles and the API behind
// one reverse proxy needs no configuration at all. Set CIXTECH_API_BASE when they
// are on different hosts.
window.CIXTECH = { apiBase: "" };
