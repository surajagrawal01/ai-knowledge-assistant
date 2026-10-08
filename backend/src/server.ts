// backend/src/server.ts: STARTS the app
import { app } from "./app.js";
import { env } from "./core/env.js";

app.listen(env.PORT, () => console.log(`Server is running, API on http://localhost:${env.PORT}`));