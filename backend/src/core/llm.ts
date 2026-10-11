import { GoogleGenAI } from "@google/genai";
import { env } from "./env.js";

export const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
export const MODEL = env.GEMINI_MODEL;

// Provider-neutral shapes: no Gemini names leak out of this file.
export type Usage = { inputTokens: number; outputTokens: number };

export type GenerateTextInput = {
    system?: string;        // the model's "job description"
    prompt: string;         // the user input
    temperature?: number;   // defaults to 0
};

export async function generateText(input: GenerateTextInput): Promise<{ text: string; usage: Usage }> {
    const res = await ai.models.generateContent({
        model: MODEL,
        contents: input.prompt,
        config: {
            systemInstruction: input.system,
            temperature: input.temperature ?? 0,
        },
    });

    const usage: Usage = {
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    };
    console.log(`[llm] ${MODEL} in=${usage.inputTokens} out=${usage.outputTokens}`);

    return { text: res.text ?? "", usage };
}