import "./globals.css";
import "../components/ui.css";
import React from "react";

export const metadata = {
  title: "40K Campaign Console",
  description: "Campaign Console for the small scale 40K Skirmishes"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
