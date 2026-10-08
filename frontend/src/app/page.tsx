// frontend/src/app/page.tsx
"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

export default function Home() {
  const [status, setStatus] = useState("checking...");
  useEffect(() => {
    apiGet<{ ok: boolean }>("/health")
      .then(() => setStatus("backend connected ✅"))
      .catch(() => setStatus("backend NOT reachable ❌"));
  }, []);
  return <main className="p-8">ElectroNest Ops Assistant: {status}</main>;
}