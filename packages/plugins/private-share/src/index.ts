import { type Plugin, tool } from "@opencode-ai/plugin";

export const PrivateSharePlugin: Plugin = async () => {
	return {
		tool: {
			"private-share": tool({
				description: "Share the session privately.",
				args: {},
				async execute(_, ctx) {
					return `Helloooooooo world: ${ctx.sessionID}`;
				},
			}),
		},
	};
};

export default PrivateSharePlugin;
