// frontend/src/app/page.tsx
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";

export default function Home() {
  const [status, setStatus] = useState("checking...");
  useEffect(() => {
    apiGet<{ ok: boolean }>("/health")
      .then(() => setStatus("backend connected ✅"))
      .catch(() => setStatus("backend NOT reachable ❌"));
  }, []);
  return (
    <main className="flex flex-col gap-4 p-8">
      <p>ElectroNest Ops Assistant: {status}</p>
      <Link href="/triage" className="text-blue-600 hover:underline">→ Ticket Triage</Link>
    </main>
  );
}