"use client";

import { Fragment, type ReactNode } from "react";
import { useActiveOrgId } from "@/lib/hooks/use-active-org";

/**
 * 组织作用域边界（ToB R1；需求 15.1.4「无缓存串数据」；评审 R2-I07）。
 *
 * 以当前组织 id 作为子树的 key：组织变化时 React 卸载整棵旧组织子树并重新挂载，
 * 于是页面内的全部状态都从零开始——
 * - 挂载态的 useQuery 观察者重新订阅（clearOrganizationScopedQueries 的 removeQueries
 *   只是把查询移出缓存，**不会通知仍挂载的观察者**；未订阅组织 store 的组件不会
 *   重渲染，此前会永久停在旧组织的数据上，且零请求发往新组织）；
 * - 组件本地状态（表单输入、分页、筛选、initializedRef 之类「只初始化一次」的 ref）；
 * - 命令式 useEffect 拉取（不走 React Query，缓存清理完全触达不到）。
 *
 * 只包裹随组织变化的业务区；侧栏导航、组织切换器、当前用户信息不受影响。
 * 未选组织时 key 为 "none"：此时路由分流不会放行业务页面（/invitations 除外，其为
 * 个人端点），子树照常渲染。
 *
 * 豁免路由（bypass，评审 R3-I01）：/invitations/* 的页面自己切换组织——接受邀请时
 * 调 switchOrganization 进入新组织。若照常按组织重挂载，页面本地状态会在同一次
 * 提交里被清掉：「已加入组织 / 进入工作台」永不出现，页面回弹成未接受的表单。
 * 这类路由不依赖组织上下文，子树使用固定 key、不随组织变化重挂载。前提是子树内
 * 的组织数据查询按组织分键（withOrgScope + enabled 门控），不靠重挂载换数据。
 */
export function OrganizationScopeBoundary({
	bypass = false,
	children,
}: {
	/** true = 不随组织变化重挂载（豁免路由；判定见 isOrglessRouteAllowed） */
	bypass?: boolean;
	children: ReactNode;
}) {
	const activeOrganizationId = useActiveOrgId();
	return (
		<Fragment key={bypass ? "orgless" : (activeOrganizationId ?? "none")}>
			{children}
		</Fragment>
	);
}
