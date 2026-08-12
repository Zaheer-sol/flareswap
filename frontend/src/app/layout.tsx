import type {Metadata, Viewport} from "next";
import "./globals.css";
import {WalletProvider} from "@/lib/wallet";
import {ToastProvider} from "@/components/Toast";
import {Navbar} from "@/components/Navbar";
import {MobileNav} from "@/components/MobileNav";
import {Footer} from "@/components/Footer";

export const metadata: Metadata = {
  title: {default: "FlareSwap — Cross-chain intent DEX", template: "%s · FlareSwap"},
  description:
    "Swap XRP on the XRP Ledger for tokens on Flare in one step. Deposits verified by the Flare " +
    "Data Connector, priced by FTSOv2, bridged by FAssets.",
  applicationName: "FlareSwap",
  keywords: ["Flare", "FTSO", "FDC", "FAssets", "FXRP", "XRPL", "intent", "cross-chain", "DEX"],
  openGraph: {
    title: "FlareSwap — Cross-chain intent DEX",
    description: "One intent. XRP in on XRPL, USDC out on Flare.",
    type: "website",
  },
  robots: {index: true, follow: true},
};

export const viewport: Viewport = {
  themeColor: "#070912",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <WalletProvider>
          <ToastProvider>
            {/* Keyboard users land here first; the nav is long on mobile. */}
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-flare-500 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
            >
              Skip to content
            </a>
            <Navbar />
            <main id="main" className="mx-auto min-h-[70vh] max-w-7xl px-4 py-10 sm:px-6">
              {children}
            </main>
            <Footer />
            <MobileNav />
          </ToastProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
