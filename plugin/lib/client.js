// @pointylab/dsh 的界面那一半：在 DSH 页面里长轮询宿主，Pointy卡片点了"在 DSH 中打开"时，
// 宿主回一个会话 id，这里用 DSH 自己的 uiWorkspace.openSession 切过去。手写的，不经过打包。
window.__ModuleLoader__.load({
	id: "@pointylab/dsh",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const RPC_CHANNEL = "/pointy";
		const RETRY_MS = 3000;
		const inject = ["connection", "uiWorkspace"];
		function apply(ctx) {
			const connection = ctx.get("connection");
			let alive = true;
			ctx.effect(() => () => { alive = false; }, "pointy: focus loop");
			(async () => {
				while (alive) {
					try {
						// 宿主最多挂 20 秒，没有要打开的会话就回 null，再问一次
						const result = await connection.rpc.call(RPC_CHANNEL, "next-focus", { origin: location.origin });
						if (!alive) break;
						if (result?.ok && typeof result.value === "string") ctx.uiWorkspace.openSession(result.value);
					} catch {
						await new Promise((r) => setTimeout(r, RETRY_MS));
					}
				}
			})();
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
