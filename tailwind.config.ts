import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        // Latin display font first, then a broad system-font fallback stack so
        // Cyrillic / Greek / CJK / Arabic / Hebrew / Thai / Devanagari text renders
        // with the OS's native font instead of tofu boxes (Space Grotesk is
        // Latin-only). No binary font assets shipped; the OS provides the coverage.
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans Arabic', 'Noto Sans Hebrew', 'Noto Sans Thai', 'Noto Sans Devanagari', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Noto Sans Mono', 'monospace'],
        display: ['system-ui', '-apple-system', 'Segoe UI', 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans Arabic', 'sans-serif'],
      },
      colors: {
        white: 'rgb(var(--appearance-text-rgb) / <alpha-value>)',
        text: {
          primary: 'var(--appearance-text)',
          secondary: 'var(--appearance-muted)',
          tertiary: 'var(--appearance-subtle)',
          disabled: 'var(--appearance-subtle)',
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
          success: 'rgb(var(--appearance-success-rgb) / <alpha-value>)',
          danger: 'rgb(var(--appearance-danger-rgb) / <alpha-value>)',
          warning: 'rgb(var(--appearance-warning-rgb) / <alpha-value>)',
          purple: 'rgb(var(--appearance-purple-rgb) / <alpha-value>)',
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        bg: {
          0: 'rgb(var(--appearance-background-rgb) / <alpha-value>)',
          1: 'rgb(var(--appearance-surface-rgb) / <alpha-value>)',
          2: 'rgb(var(--appearance-elevated-rgb) / <alpha-value>)',
        },
        surface: {
          dark: 'rgb(var(--appearance-surface-rgb) / <alpha-value>)',
        },
        'primary-dark': 'rgb(var(--appearance-accent-rgb) / <alpha-value>)',
        'primary-dim': 'rgb(var(--appearance-accent-rgb) / <alpha-value>)',
        stroke: {
          subtle: 'rgb(var(--appearance-border-rgb) / .65)',
          DEFAULT: 'rgb(var(--appearance-border-rgb) / <alpha-value>)',
          strong: 'rgb(var(--appearance-border-rgb) / <alpha-value>)',
          primary: 'rgb(var(--appearance-accent-rgb) / .65)',
        },
        glass: {
          card: 'var(--appearance-surface)',
          panel: 'var(--appearance-surface)',
          overlay: 'rgb(var(--appearance-text-rgb) / .03)',
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        'r1': '10px',
        'r2': '16px',
        'r3': '24px',
        'r4': '32px',
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
