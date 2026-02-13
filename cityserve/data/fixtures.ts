// ---------- Types ----------

export interface UserProfile {
  name: string;
  email: string;
  address: string;
  accountNumber: string;
}

export interface MockUser {
  username: string;
  password: string;
  profile: UserProfile;
}

export interface BillPeriod {
  amount: number;
  dueDate: string;
  billingPeriod: string;
  status: "unpaid" | "paid" | "overdue";
}

export interface UsageRecord {
  month: string;
  gallons: number;
  amount: number;
}

export interface WaterBill {
  accountNumber: string;
  serviceAddress: string;
  currentBill: BillPeriod;
  usageHistory: UsageRecord[];
}

export interface ServiceItem {
  id: string;
  name: string;
  description: string;
  url: string;
  icon: string;
  available: boolean;
}

// ---------- Mock Data ----------

export const mockUser: MockUser = {
  username: "mike.chen",
  password: "cityserve2025",
  profile: {
    name: "Mike Chen",
    email: "mike.chen@email.com",
    address: "1234 Oak Street, Bay Area, CA 94102",
    accountNumber: "CS-2025-84291",
  },
};

export const mockWaterBill: WaterBill = {
  accountNumber: "CS-2025-84291",
  serviceAddress: "1234 Oak Street, Bay Area, CA 94102",
  currentBill: {
    amount: 84.5,
    dueDate: "2026-03-01",
    billingPeriod: "Jan 15 – Feb 14, 2026",
    status: "unpaid",
  },
  usageHistory: [
    { month: "Feb 2026", gallons: 4200, amount: 84.5 },
    { month: "Jan 2026", gallons: 3800, amount: 76.0 },
    { month: "Dec 2025", gallons: 3500, amount: 70.0 },
    { month: "Nov 2025", gallons: 3900, amount: 78.0 },
    { month: "Oct 2025", gallons: 4100, amount: 82.0 },
    { month: "Sep 2025", gallons: 4800, amount: 96.0 },
  ],
};

export const mockServices: ServiceItem[] = [
  {
    id: "water",
    name: "Water & Sewer Bill",
    description:
      "View and pay your water and sewer utility bill, check usage history, and manage your account.",
    url: "/water-bill.html",
    icon: "droplet",
    available: true,
  },
  {
    id: "vehicle",
    name: "Vehicle Registration",
    description:
      "Renew your vehicle registration, update ownership information, and pay fees online.",
    url: "#",
    icon: "car",
    available: false,
  },
  {
    id: "parks",
    name: "Park Permits",
    description:
      "Reserve picnic areas, sports fields, and event spaces in city parks.",
    url: "#",
    icon: "tree",
    available: false,
  },
  {
    id: "issue",
    name: "Report an Issue",
    description:
      "Report potholes, streetlight outages, graffiti, and other city maintenance issues.",
    url: "#",
    icon: "alert",
    available: false,
  },
];

// ---------- Session Store ----------

export interface Session {
  token: string;
  username: string;
  createdAt: number;
}

/** In-memory session store: token → Session */
export const sessions = new Map<string, Session>();
