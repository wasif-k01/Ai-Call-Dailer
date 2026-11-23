import {
  Activity, BarChart3, Bot, Contact, FileText, History, LayoutDashboard, Megaphone, Mic,
  Phone, PhoneCall, PlugZap, Settings, Sparkles,
} from "lucide-react";

export const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, phase: 1 },
  { href: "/dialer", label: "Dialer", icon: Phone, phase: 3 },
  { href: "/ai-calling", label: "AI Calling", icon: Sparkles, phase: 4 },
  { href: "/campaigns", label: "Bulk Campaigns", icon: Megaphone, phase: 6 },
  { href: "/contacts", label: "Contacts", icon: Contact, phase: 6 },
  { href: "/live-calls", label: "Live Calls", icon: Activity, phase: 7 },
  { href: "/call-history", label: "Call History", icon: History, phase: 7 },
  { href: "/recordings", label: "Recordings", icon: Mic, phase: 7 },
  { href: "/transcripts", label: "Transcripts", icon: FileText, phase: 7 },
  { href: "/agents", label: "AI Agents", icon: Bot, phase: 5 },
  { href: "/phone-numbers", label: "Phone Numbers", icon: PhoneCall, phase: 2 },
  { href: "/integrations", label: "Integrations & API", icon: PlugZap, phase: 2 },
  { href: "/usage", label: "Usage & Costs", icon: BarChart3, phase: 8 },
  { href: "/settings", label: "Account Settings", icon: Settings, phase: 1 },
] as const;
