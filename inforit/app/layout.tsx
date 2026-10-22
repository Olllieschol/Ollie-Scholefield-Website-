import type { Metadata, Viewport } from "next";
import { Archivo, Atkinson_Hyperlegible_Next } from "next/font/google";
import { APP_NAME, APP_PROMISE } from "@/lib/config";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
});

const atkinson = Atkinson_Hyperlegible_Next({
  variable: "--font-atkinson",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_PROMISE,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#f7f2e9",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-AU" className={`${archivo.variable} ${atkinson.variable} antialiased`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
