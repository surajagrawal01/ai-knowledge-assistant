import { z } from "zod";
import { ai, MODEL } from "../src/core/llm.js";   // raw SDK client, for learning V0
import { TicketExtractionSchema } from "../src/modules/ticket-extractor/ticket.schema.js";
import { EXTRACTION_SYSTEM_PROMPT } from "../src/modules/ticket-extractor/ticket.prompt.js";

export async function extractTicketV0(message: string) {
    const res = await ai.models.generateContent({
        model: MODEL,
        contents: `Today's date: ${new Date().toISOString().slice(0, 10)}\n\nCustomer message:\n"""\n${message}\n"""`,
        config: {
            systemInstruction: EXTRACTION_SYSTEM_PROMPT,
            responseMimeType: "application/json",
            responseJsonSchema: z.toJSONSchema(TicketExtractionSchema),
            temperature: 0,
        },
    });

    console.log("LLM:", res);
    const parsed = TicketExtractionSchema.safeParse(JSON.parse(res.text ?? ""));
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    console.log("Parsed ticket:", parsed);
    return parsed.data;
}



// console.log(await extractTicketV0("mera phone toot ke aaya hai, screen crack hai. O033, Vikram"));
console.log(await extractTicketV0("I will go to CONSUMER COURT if I don't get my refund TODAY!!! Order O035"));
console.log(await extractTicketV0("Both the buds and the charger from O045 are dead now. C003"));

//Run the script To Test
// npx tsx --env-file=.env backend/scripts/try-extract.ts