import type { Plugin } from "@opencode-ai/plugin";

export const PrivateSharePlugin: Plugin = async () => {
	console.log("hello world!");
	return {
		event: async ({ event }) => {
			if (
				event.type === "session.created" ||
				event.type === "session.updated"
			) {
				console.log("HELLO WORLD", event.type);
			}
		},
	};
};

export default PrivateSharePlugin;
