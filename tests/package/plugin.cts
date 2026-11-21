import runtime = require("@ilya_coder/injektor");

@runtime.injectable()
class PluginService {}
export = { runtime, PluginService };
