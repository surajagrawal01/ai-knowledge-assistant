// backend/src/server.ts: STARTS the app
import { app } from "./app.js";
import { env } from "./core/env.js";
import { prisma } from "./core/prisma.js";

async function startServer() {
	try {
		await prisma.$connect();
		console.log("Database connection established");
		app.listen(env.PORT, () => console.log(`Server is running, API on http://localhost:${env.PORT}`));
	} catch (error) {
		console.error("Failed to connect to the database:", error);
		process.exit(1);
	}
}

void startServer();