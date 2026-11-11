import type { ReactNode } from "react";

// The shared frame of the three result panels: number, title, which part of Mini 1 produced it.
export function Panel({ step, title, part, children }: { step: string; title: string; part: string; children: ReactNode }) {
    return (
        <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <header className="flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-bold uppercase tracking-wide">
                    {step} {title}
                </h2>
                <span className="text-xs text-neutral-500">{part}</span>
            </header>
            {children}
        </section>
    );
}
