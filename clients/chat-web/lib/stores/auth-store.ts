import { create } from "zustand";
import type { AuthUser } from "@/lib/api/contract";

type User = AuthUser;

interface AuthStore {
	user: User | null;
	isAuthenticated: boolean;

	setUser: (user: User) => void;
	clearUser: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
	user: null,
	isAuthenticated: false,

	setUser: (user) => set({ user, isAuthenticated: true }),

	clearUser: () => set({ user: null, isAuthenticated: false }),
}));
