// backend/src/core/env.ts
import { z } from "zod";

const EnvSchema = z.object({
    PORT: z.coerce.number().default(4000),     // coerce: "4000" (string) → 4000
    //FRONTEND_URL=http://localhost:3000,http://localhost:5173 To allow multiple origins, 
    // we can split the string by commas and trim whitespace. 
    // The resulting array will be used in the CORS configuration.
    FRONTEND_URL: z
        .string()
        .transform((value) =>
            value
                .split(",")
                .map((url) => url.trim())
                .filter(Boolean)
        ),
    GEMINI_API_KEY: z.string().min(1),
    GEMINI_MODEL: z.string().min(1),
    DATABASE_URL: z.string().min(1),
    DIRECT_URL: z.string().min(1),
});

export const env = EnvSchema.parse(process.env);   // throws with a clear message if invalid