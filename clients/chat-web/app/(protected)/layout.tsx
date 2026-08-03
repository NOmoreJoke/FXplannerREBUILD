'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { authApi } from '@/lib/api/auth';
import { useAuthStore } from '@/lib/stores/auth-store';
import { PageLoading } from '@/components/base';

/**
 * 保护区守卫（路由组 (protected) 的唯一入口）
 *
 * 放在本组下的所有页面自动受保护：无 token 或 token 失效 → 跳 /login 并带 redirect 回跳地址。
 * 新增受保护页面只需放进 (protected)/ 目录，无需再写任何校验代码。
 * 公开页面（落地页、login、register）不要放进本组。
 */
export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { setUser, clearUser } = useAuthStore();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
        return;
      }

      try {
        const user = await authApi.getMe();
        setUser(user);
        setChecking(false);
      } catch {
        clearUser();
        router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
      }
    };

    checkAuth();
  }, [router, pathname, setUser, clearUser]);

  if (checking) {
    return <PageLoading />;
  }

  return <>{children}</>;
}
