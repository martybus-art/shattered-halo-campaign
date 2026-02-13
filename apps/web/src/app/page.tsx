"use client";
import React, { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { Frame } from "@/components/Frame";
import { Card } from "@/components/Card";

export default function Home() {
  const supabase = supabaseBrowser();
  const [email, setEmail] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
  (async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      console.warn(error);
      setUserEmail(null);
      return;
    }
    setUserEmail(data.user?.email ?? null);
  })();
}, [supabase]);

  const sendMagicLink = async () => {
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) alert(error.message);
    else alert("Check your email for the login link.");
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    location.reload();
  };

  return (
    <Frame title="Access">
      <div className="grid md:grid-cols-2 gap-6">
        <Card title="Enter the Halo">
          {userEmail ? (
            <div className="space-y-3">
              <p className="text-parchment/80">Signed in as <span className="text-parchment">{userEmail}</span></p>
              <div className="flex gap-3">
                <a className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" href="/campaigns">Go to Dashboard</a>
                <button className="px-4 py-2 rounded bg-blood/30 border border-blood/50 hover:bg-blood/40" onClick={signOut}>Sign out</button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-parchment/80">Login via magic link.</p>
              <input className="w-full px-3 py-2 rounded bg-void border border-brass/30"
                placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="px-4 py-2 rounded bg-brass/20 border border-brass/40 hover:bg-brass/30" onClick={sendMagicLink}>
                Send login link
              </button>
            </div>
          )}
        </Card>

        <Card title="What this is">
          <ul className="list-disc pl-5 space-y-2 text-parchment/80">
            <li>Secret movement + fog-of-war map reveals</li>
            <li>NIP/NCP economies with audit ledger</li>
            <li>Conflicts auto-detected, missions assigned (with NIP influence)</li>
            <li>Instability clock drives escalation and endgame</li>
          </ul>
        </Card>
      </div>
    </Frame>
  );
}
