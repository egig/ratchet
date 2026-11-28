# Feature packages are plugins, starting with automation

Agents, chat and workflows were built into `@egig/ratchet`. Every app paid for them: LangChain,
assistant-ui, Inngest and React Flow were core dependencies, their tables were always generated,
and core hard-wired them in codegen (`BUILTIN_MODELS`), the server mount order, first-admin setup
(the default agent), the console routes and the console/workspace chat panels. We moved them into
`@egig/ratchet-automation`, its own repo (`egig/ratchet-automation`), and
added a general plugin contract (`src/plugin/`) that core uses to wire any feature package.

Decisions, and why:

- **Explicit `plugins: [automation({...})]` in `ratchet.config.ts`**, not auto-discovery of
  installed packages. Options sit next to the plugin and are typed, and nothing loads that the
  config doesn't name, which is easier for people and coding agents to reason about. A
  `ratchet add <name>` command can later write this line.
- **A general contract, sized to what automation needs** (`RatchetPlugin`): models/domains/forms,
  routes, `decorateDb`, `onSetup`, `service`, `requires`/`optional`, console modules and console
  styles. Workspace exposes its first piece (a service) through it, ahead of its own extraction.
  `apiVersion` is checked at codegen and boot so an incompatible plugin fails with a clear error.
- **Plugins get a `PluginContext`, not core's internals as package exports.** Its `kit` groups the
  persistence, query, access, HTTP and serialization helpers core's own routers use, so plugin
  reads and writes get identical validation and field-level access. Core can reshape its files
  freely as long as that object's shape holds.
- **Plugin models are scanned like built-ins.** `module` plays `builtinPackage`'s role: generated
  files import each model from the plugin package by name. Plugin tables are migrated by the
  consumer's own drizzle-kit journal, so adding a plugin is just another reviewed migration. All
  automation models are registered whatever its options say, so toggling `agents`/`workflows`
  never changes the schema.
- **`.ratchet/app.ts` imports `ratchet.config.ts`** and carries `bundle.plugins`. Plugin objects
  hold functions, so they can't be serialized into generated code; importing the config is how
  `ratchet serve`, `dist/server.js` and hand-written Worker/Vercel entries all get them unchanged.
  This generalizes what `ratchet build` already did for `FrameworkConfig.auth`.
- **Routes mount between `/api/auth` and `/api/:model`**, in plugin order, under `/api/<segment>`
  prefixes. Boot rejects a prefix that equals a model name, which would otherwise silently shadow
  that model's generic routes. Automation keeps `/api/automation` and `/api/workflows` unchanged.
- **Console UI arrives through a `ratchet:plugins` virtual module**, the same mechanism as
  `ratchet:custom-forms`. A plugin's browser code is a separate module specifier, because console
  code can't travel inside the server-side plugin object. It contributes routes (matched before
  `:model/*`) and fills named panel slots (`shellPanel`, `workspacePanel`); a slot's toggle only
  appears when a plugin fills it. Plugin peer-depends on React, React Router, React Query and
  `@egig/ratchet`, so the bundle has one copy of each, and declares Tailwind `@source`/CSS inputs
  because its `.tsx` lives in `node_modules`.
- **Clean break, no shim.** A re-export from `@egig/ratchet/automation` would make core depend on
  the plugin, which defeats the split.
