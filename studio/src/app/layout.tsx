import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth-context";
import { OfflineServiceWorker } from "@/components/offline-service-worker";
import { ConnectivityProvider } from "@/lib/connectivity";
import "./globals.css";

const display = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const sans = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "mdmedia studio",
  description: "Turn writing into narration you can read along with.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icon.svg",
        type: "image/svg+xml",
      },
    ],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${display.variable} ${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <OfflineServiceWorker />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          storageKey="mdmedia.theme"
          disableTransitionOnChange
        >
          <ConnectivityProvider>
            <AuthProvider>
              <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
              <Toaster position="bottom-right" />
            </AuthProvider>
          </ConnectivityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
