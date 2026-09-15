import { Suspense } from "react";
import { RegisterForm } from "@/components/business/auth";
import { PageLoading } from "@/components/base";

export default function RegisterPage() {
	return (
		<Suspense fallback={<PageLoading />}>
			<RegisterForm />
		</Suspense>
	);
}
