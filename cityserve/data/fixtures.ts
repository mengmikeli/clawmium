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

export interface VehicleRegistration {
  plate: string;
  vin: string;
  year: number;
  make: string;
  model: string;
  color: string;
  owner: string;
  status: "active" | "expired";
  expirationDate: string;
  registrationFee: number;
}

export interface ParkPermit {
  type: string;
  description: string;
  fee: number;
  available: boolean;
}

export interface Park {
  id: string;
  name: string;
  address: string;
  acres: number;
  amenities: string[];
  permits: ParkPermit[];
}

export interface IssueReport {
  id: string;
  category: string;
  location: string;
  description: string;
  status: "open" | "in-progress" | "resolved";
  createdAt: string;
  updatedAt: string;
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
    url: "/vehicle.html",
    icon: "car",
    available: true,
  },
  {
    id: "parks",
    name: "Park Permits",
    description:
      "Reserve picnic areas, sports fields, and event spaces in city parks.",
    url: "/parks.html",
    icon: "tree",
    available: true,
  },
  {
    id: "issue",
    name: "Report an Issue",
    description:
      "Report potholes, streetlight outages, graffiti, and other city maintenance issues.",
    url: "/report.html",
    icon: "alert",
    available: true,
  },
];

// ---------- Vehicle Registration ----------

export const mockVehicles: VehicleRegistration[] = [
  {
    plate: "ABC1234",
    vin: "1HGCM82633A004352",
    year: 2022,
    make: "Toyota",
    model: "Camry",
    color: "Silver",
    owner: "Mike Chen",
    status: "active",
    expirationDate: "2026-08-15",
    registrationFee: 145,
  },
  {
    plate: "XYZ9876",
    vin: "2HGES16575H532684",
    year: 2019,
    make: "Honda",
    model: "Civic",
    color: "Blue",
    owner: "Mike Chen",
    status: "expired",
    expirationDate: "2025-11-30",
    registrationFee: 132,
  },
];

// ---------- Parks & Permits ----------

export const mockParks: Park[] = [
  {
    id: "riverside",
    name: "Riverside Park",
    address: "200 River Road, Bay Area, CA 94102",
    acres: 45,
    amenities: ["Playground", "Bike trails", "Fishing pier", "Picnic shelters"],
    permits: [
      { type: "Picnic Shelter", description: "Covered picnic area with tables and grill, seats up to 30", fee: 25, available: true },
      { type: "Sports Field", description: "Multi-use sports field (soccer, flag football)", fee: 60, available: true },
      { type: "Event Space", description: "Riverside pavilion for events up to 100 guests", fee: 150, available: true },
    ],
  },
  {
    id: "oakwood",
    name: "Oakwood Meadow",
    address: "450 Oak Boulevard, Bay Area, CA 94103",
    acres: 28,
    amenities: ["Dog park", "Walking trails", "Community garden"],
    permits: [
      { type: "Picnic Area", description: "Open-air picnic area near the meadow, seats up to 20", fee: 30, available: true },
      { type: "Event Space", description: "Meadow event area for gatherings up to 75 guests", fee: 200, available: false },
    ],
  },
  {
    id: "cedar-ridge",
    name: "Cedar Ridge Reserve",
    address: "780 Cedar Hill Drive, Bay Area, CA 94104",
    acres: 62,
    amenities: ["Hiking trails", "Nature center", "Bird watching stations"],
    permits: [
      { type: "Picnic Shelter", description: "Mountain-view shelter with firepit, seats up to 25", fee: 35, available: true },
      { type: "Sports Field", description: "Baseball diamond and adjacent practice field", fee: 75, available: true },
    ],
  },
  {
    id: "harbor-point",
    name: "Harbor Point",
    address: "15 Marina Way, Bay Area, CA 94105",
    acres: 18,
    amenities: ["Waterfront promenade", "Boat launch", "Fishing dock"],
    permits: [
      { type: "Picnic Area", description: "Waterfront picnic tables with bay views, seats up to 15", fee: 40, available: true },
      { type: "Event Space", description: "Harbor pavilion for events up to 50 guests", fee: 120, available: true },
    ],
  },
  {
    id: "sunnyvale",
    name: "Sunnyvale Community Park",
    address: "320 Sunny Lane, Bay Area, CA 94106",
    acres: 35,
    amenities: ["Splash pad", "Basketball courts", "Skate park", "Picnic areas"],
    permits: [
      { type: "Picnic Shelter", description: "Family shelter near the splash pad, seats up to 40", fee: 30, available: true },
      { type: "Sports Field", description: "Lighted basketball and volleyball courts", fee: 65, available: true },
      { type: "Event Space", description: "Community center outdoor patio for events up to 120 guests", fee: 175, available: true },
    ],
  },
];

// ---------- Issue Reports ----------

export const reportCategories: string[] = [
  "Pothole",
  "Streetlight",
  "Graffiti",
  "Sidewalk",
  "Other",
];

export const mockReports: IssueReport[] = [
  {
    id: "RPT-2026-001",
    category: "Pothole",
    location: "500 Block of Elm Street",
    description: "Large pothole in the right lane, approximately 2 feet wide. Hazardous to cyclists.",
    status: "resolved",
    createdAt: "2026-01-10T14:30:00Z",
    updatedAt: "2026-01-22T09:15:00Z",
  },
  {
    id: "RPT-2026-002",
    category: "Streetlight",
    location: "Corner of 3rd Ave and Pine Street",
    description: "Streetlight has been out for two weeks. Area is very dark at night.",
    status: "open",
    createdAt: "2026-02-03T11:45:00Z",
    updatedAt: "2026-02-03T11:45:00Z",
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
