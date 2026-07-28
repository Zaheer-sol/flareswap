import type {Config} from "tailwindcss";

/**
 * Palette is built around Flare's brand orange on a deep navy ground, with a single cyan accent
 * reserved for "verified by Flare" moments (FDC proof, FTSO price) so those read as a distinct
 * signal rather than more chrome.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#070912",
          900: "#0b0f1c",
          850: "#101728",
          800: "#151d33",
          700: "#1e2842",
          600: "#2b3757",
          500: "#3d4a6d",
        },
        flare: {
          50: "#fff3ed",
          100: "#ffe3d4",
          200: "#ffc2a8",
          300: "#ff9871",
          400: "#ff6a38",
          500: "#f24e18",
          600: "#e3350d",
          700: "#bc250e",
          800: "#952013",
          900: "#781f13",
        },
        verify: {
          300: "#7dd3fc",
          400: "#38bdf8",
          500: "#0ea5e9",
          600: "#0284c7",
        },
        mint: {
          400: "#4ade80",
          500: "#22c55e",
          600: "#16a34a",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 18px 40px -24px rgba(0,0,0,0.9)",
        glow: "0 0 0 1px rgba(242,78,24,0.35), 0 12px 40px -12px rgba(242,78,24,0.45)",
      },
      keyframes: {
        "pulse-ring": {
          "0%": {transform: "scale(0.85)", opacity: "0.8"},
          "70%": {transform: "scale(1.6)", opacity: "0"},
          "100%": {transform: "scale(1.6)", opacity: "0"},
        },
        shimmer: {
          "100%": {transform: "translateX(100%)"},
        },
        "fade-up": {
          from: {opacity: "0", transform: "translateY(6px)"},
          to: {opacity: "1", transform: "translateY(0)"},
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 1.8s cubic-bezier(0.4,0,0.6,1) infinite",
        shimmer: "shimmer 2s infinite",
        "fade-up": "fade-up 0.25s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
