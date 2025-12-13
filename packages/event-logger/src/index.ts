import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({
	baseUrl: "http://localhost:4096",
});

console.log("Starting opencode event-logger...");

try {
	const events = await client.event.subscribe();
	console.log("Subscribed to opencode client events!");

	for await (const event of events.stream) {
		console.log("Event:", event.type, event.properties);
	}
} catch (error) {
	console.error("Error subscribing to events:", error);
}
