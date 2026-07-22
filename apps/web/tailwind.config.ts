// Excerpted from a private production codebase for portfolio purposes.
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx,js,jsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Primary
        stone: { DEFAULT: "#2C2825" },
        warmWhite: "#FAF8F5",
        softCream: "#F5F1EB",
        deepCharcoal: "#1A1817",
        softCharcoal: "#252220",
        // Accents
        sage: "#8B9A7E",
        terracotta: "#C4856A",
        sand: "#D4C4B0",
        clay: "#A68B73",
        mist: "#B8C4C4",
        // Semantic
        success: "#7A9A6E",
        warning: "#D4A456",
        critical: "#C46A6A",
        info: "#6A8FA4",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        serif: ["'Cormorant Garamond'", "Georgia", "serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      fontSize: {
        display: ["36px", { lineHeight: "1.2", fontWeight: "500" }],
        h1: ["28px", { lineHeight: "1.3", fontWeight: "500" }],
        h2: ["22px", { lineHeight: "1.3", fontWeight: "500" }],
        h3: ["18px", { lineHeight: "1.4", fontWeight: "500" }],
        body: ["15px", { lineHeight: "1.6", fontWeight: "400" }],
        small: ["13px", { lineHeight: "1.5", fontWeight: "400" }],
        tiny: ["11px", { lineHeight: "1.4", fontWeight: "500" }],
      },
      spacing: {
        xs: "4px",
        sm: "8px",
        md: "16px",
        lg: "24px",
        xl: "32px",
        "2xl": "48px",
        "3xl": "64px",
      },
      borderRadius: {
        sm: "4px",
        md: "8px",
        lg: "12px",
        full: "9999px",
      },
      boxShadow: {
        sm: "0 1px 2px rgba(44, 40, 37, 0.05)",
        md: "0 4px 12px rgba(44, 40, 37, 0.08)",
        lg: "0 12px 32px rgba(44, 40, 37, 0.12)",
      },
      transitionDuration: {
        fast: "100ms",
        normal: "200ms",
        slow: "300ms",
      },
      transitionTimingFunction: {
        northbound: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      screens: {
        mobile: { max: "639px" },
        tablet: { min: "640px", max: "1023px" },
        desktop: { min: "1024px" },
        wide: { min: "1440px" },
      },
    },
  },
  plugins: [],
};

export default config;
