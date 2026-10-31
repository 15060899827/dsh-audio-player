/**
 * dsh-audio 浏览器端：把 play_audio 的结果画成播放器。
 *
 * 两个位置：
 *  1. tool.call.toolview —— 工具折叠里的卡片（默认兜底）
 *  2. conversation.chat.node —— 提升到正文里的节点（uiConversation 可用时）
 *
 * 约定：
 *  - exports.inject 必须声明 "slots"，apply() 里才拿得到 ctx.slots（上一版就栽在这）
 *  - toolview 的注册键是 `key`（工具名），register 内部用 this，要先 bind
 *  - promoted 节点由 uiConversation.events.register 的 definition 驱动，
 *    match 命中 tool/result 且 meta.kind === "dsh-audio" 时，正文里画一个播放器
 */
window.__ModuleLoader__.load({
	id: "dsh-audio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");

		var KIND = "dsh-audio";

		/** 工具结果里的 url 由 host 的 presentationMeta 投影到 block.meta。 */
		function readMeta(block) {
			if (block === null || typeof block !== "object") return {};
			var candidates = [block.meta, block.resultView && block.resultView.meta];
			for (var i = 0; i < candidates.length; i += 1) {
				var value = candidates[i];
				if (value && typeof value === "object" && typeof value.url === "string" && value.url.length > 0) {
					return value;
				}
			}
			return {};
		}

		function player(url, title) {
			return React.createElement(
				"div",
				{
					style: {
						width: "100%",
						padding: "8px 0",
						display: "flex",
						flexDirection: "column",
						gap: "6px",
					},
				},
				title !== ""
					? React.createElement(
						"div",
						{ style: { fontSize: "12px", opacity: 0.72, wordBreak: "break-all" } },
						title,
					)
					: null,
				React.createElement("audio", {
					controls: true,
					preload: "metadata",
					src: url,
					style: { width: "100%", height: "38px" },
				}),
			);
		}

		/** 工具折叠里的卡片；提升到正文后不再重复画一遍。 */
		function AudioCard(props) {
			if (props && props.promoted) return null;
			var meta = readMeta(props && props.block);
			var url = typeof meta.url === "string" ? meta.url : "";
			if (url === "") return null;
			return player(url, typeof meta.title === "string" ? meta.title : "");
		}

		/** 正文节点：props.node.data 由 buildViewNode 产出。 */
		function PromotedAudio(props) {
			var data = (props && props.node && props.node.data) || {};
			var url = typeof data.url === "string" ? data.url : "";
			if (url === "") return null;
			return player(url, typeof data.title === "string" ? data.title : "");
		}

		function eventTurn(event) {
			var turn = event && event.data ? event.data.turn : void 0;
			return typeof turn === "number" && Number.isSafeInteger(turn) && turn >= 0 ? turn : void 0;
		}

		/** 提升规则：一条 kind 为 dsh-audio 的工具结果 = 正文里的一个播放器。 */
		function createPlayerDefinition() {
			return {
				kind: KIND,
				target: "chat",
				match: function (event) {
					if (!event || event.type !== "tool/result") return null;
					var meta = event.data ? event.data.meta : void 0;
					if (!meta || meta.kind !== KIND) return null;
					if (typeof meta.url !== "string" || meta.url === "") return null;
					return { id: "result:" + String(event.seq), role: "start" };
				},
				start: function (_context, match) {
					var meta = match.event.data.meta;
					var turn = eventTurn(match.event);
					if (turn === void 0) throw new Error("dsh-audio start requires a Tool result with a turn");
					return {
						turn: turn,
						url: String(meta.url),
						title: typeof meta.title === "string" ? meta.title : "",
						seq: match.event.seq,
					};
				},
				update: function (context) {
					return context.state;
				},
				buildViewNode: function (context) {
					var state = context.state;
					if (state === void 0 || state === null) return null;
					return {
						key: context.key,
						kind: KIND,
						id: context.id,
						target: "chat",
						anchorSeq: state.seq,
						location: { kind: "session" },
						visibility: "visible",
						data: {
							turn: state.turn,
							url: state.url,
							title: state.title,
						},
					};
				},
			};
		}

		function apply(ctx) {
			var slots = ctx.slots;
			var register = slots.register.bind(slots);
			var promotion = { enabled: false };

			slots.inject("tool.call.toolview", function () {
				return register(
					{
						name: "tool.call.toolview",
						key: "play_audio",
						inject: function () {
							return { promoted: promotion.enabled };
						},
					},
					AudioCard,
				);
			});

			ctx.inject(["uiConversation"], function (owner) {
				var ui = owner.get("uiConversation");
				if (!ui || !ui.events || typeof ui.events.register !== "function") return;
				promotion.enabled = true;
				var ownerRegister = owner.slots.register.bind(owner.slots);
				owner.effect(
					function () {
						return ui.events.register(createPlayerDefinition());
					},
					"dsh-audio: promote player into the transcript",
				);
				owner.slots.inject("conversation.chat.node", function () {
					return ownerRegister({ name: "conversation.chat.node", key: KIND }, PromotedAudio);
				});
			});
		}

		exports.AudioCard = AudioCard;
		exports.PromotedAudio = PromotedAudio;
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
