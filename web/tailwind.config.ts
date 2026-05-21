import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0f17",
        panel: "#121826",
        muted: "#1c2433",
        line: "#2a3346",
        accent: "#3b82f6",
        success: "#10b981",
        danger: "#ef4444",
      },
    },
  },
  plugins: [],
};
export default config;
