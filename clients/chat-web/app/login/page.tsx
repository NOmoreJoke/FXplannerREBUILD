import { Suspense } from "react";
import { LoginForm } from "@/components/business/auth";
import { PageLoading } from "@/components/base";

export default function LoginPage() {
	return (
		<Suspense fallback={<PageLoading />}>
			<LoginForm />
		</Suspense>
	);
}
