export interface Product {
  id: string;
  name: string;
  category: "audio" | "computing" | "accessories";
  price: number;
  stock: number;
}

export interface Order {
  id: string;
  productId: string;
  quantity: number;
  status: "pending" | "shipped" | "delivered";
  createdAt: string;
}

export const PRODUCTS: Product[] = [
  { id: "p-100", name: "Studio Headphones", category: "audio", price: 249.0, stock: 42 },
  { id: "p-101", name: "Wireless Earbuds", category: "audio", price: 129.5, stock: 118 },
  { id: "p-102", name: "Mechanical Keyboard", category: "computing", price: 179.0, stock: 64 },
  { id: "p-103", name: "27-inch Monitor", category: "computing", price: 429.0, stock: 21 },
  { id: "p-104", name: "USB-C Dock", category: "accessories", price: 89.0, stock: 87 },
  { id: "p-105", name: "Travel Mouse", category: "accessories", price: 39.0, stock: 203 },
];

const now = Date.now();
export const ORDERS: Order[] = [
  {
    id: "o-9001",
    productId: "p-100",
    quantity: 1,
    status: "delivered",
    createdAt: new Date(now - 86_400_000 * 4).toISOString(),
  },
  {
    id: "o-9002",
    productId: "p-103",
    quantity: 2,
    status: "shipped",
    createdAt: new Date(now - 86_400_000 * 2).toISOString(),
  },
  {
    id: "o-9003",
    productId: "p-105",
    quantity: 3,
    status: "pending",
    createdAt: new Date(now - 3_600_000).toISOString(),
  },
];

export const PROFILE = {
  id: "u-42",
  name: "Demo Customer",
  email: "demo@example.com",
  tier: "gold",
  memberSince: "2023-04-18",
  preferences: { currency: "USD", notifications: true },
};
