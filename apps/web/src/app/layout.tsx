import "./globals.css";
import React from "react";

export const metadata = {
  title: "Shattered Halo Campaign",
  description: "Fog-of-war narrative campaign tracker"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
