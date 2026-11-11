import type { TicketExtraction } from "@/lib/types";
import { Panel } from "./Panel";

// Panel ①: what Part A (the extractor) read from the text. Unverified: panel ② checks it.
export function ExtractionPanel({ extracted, warnings }: { extracted: TicketExtraction | null; warnings: string[] }) {
    if (extracted === null) {
        return (
            <Panel step="①" title="Extracted" part="Part A">
                <p className="text-sm text-red-600">The message couldn&apos;t be read automatically.</p>
            </Panel>
        );
    }
    const rows: [string, string][] = [
        ["customer", extracted.customer_id ?? "—"],
        ["name", extracted.customer_name ?? "—"],
        ["email", extracted.customer_email ?? "—"],
        ["phone", extracted.customer_phone ?? "—"],
        ["order", extracted.order_id ?? "—"],
        ["products", extracted.products_mentioned.join(", ") || "—"],
        ["category", extracted.category],
        ["priority", extracted.priority],
        ["sentiment", extracted.sentiment],
        ["human?", extracted.needs_human ? "YES" : "no"],
    ];
    return (
        <Panel step="①" title="Extracted" part="Part A">
            <p className="text-sm italic">{extracted.issue_summary}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                {rows.map(([k, v]) => (
                    <div key={k} className="contents">
                        <dt className="text-neutral-500">{k}</dt>
                        <dd className={`font-mono break-words ${k === "human?" && extracted.needs_human ? "font-bold text-red-600" : ""}`}>{v}</dd>
                    </div>
                ))}
            </dl>
            {warnings.length > 0 && (
                <ul className="text-xs text-amber-700 dark:text-amber-400">
                    {warnings.map((w) => <li key={w}>⚠ {w}</li>)}
                </ul>
            )}
            <details className="text-xs">
                <summary className="cursor-pointer text-neutral-500">raw JSON</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-neutral-100 p-2 dark:bg-neutral-900">{JSON.stringify(extracted, null, 2)}</pre>
            </details>
        </Panel>
    );
}
