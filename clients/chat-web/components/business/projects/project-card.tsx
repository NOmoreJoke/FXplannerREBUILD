'use client';

import { useState } from 'react';

interface ProjectCardProps {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

export function ProjectCard({
  id,
  name,
  description,
  updatedAt,
  onDelete,
  onRename,
}: ProjectCardProps) {
  const [showMenu, setShowMenu] = useState(false);

  const handleRename = () => {
    const newName = prompt('请输入新的项目名称', name);
    if (newName && newName.trim() && newName !== name) {
      onRename(id, newName.trim());
    }
    setShowMenu(false);
  };

  const handleDelete = () => {
    if (confirm(`确定要删除项目"${name}"吗？此操作不可恢复。`)) {
      onDelete(id);
    }
    setShowMenu(false);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return `${days} 天前`;
    return date.toLocaleDateString('zh-CN');
  };

  return (
    <div
      className="bg-white rounded-lg shadow hover:shadow-lg transition-shadow p-6 relative group"
      data-testid="project-card"
    >
      <div>
        {/* 项目名称 */}
        <h3 className="text-lg font-semibold text-gray-900 mb-2 truncate">{name}</h3>

        {/* 项目描述 */}
        {description && (
          <p className="text-sm text-gray-600 mb-4 line-clamp-2">{description}</p>
        )}

        {/* 更新时间 */}
        <p className="text-xs text-gray-400">更新于 {formatDate(updatedAt)}</p>
      </div>

      {/* 操作菜单 */}
      <div className="absolute top-4 right-4">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu(!showMenu);
          }}
          className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
          </svg>
        </button>

        {/* 下拉菜单 */}
        {showMenu && (
          <>
            {/* 点击外部关闭菜单 */}
            <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />

            <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleRename();
                }}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                data-testid="rename-button"
              >
                重命名
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete();
                }}
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                data-testid="delete-button"
              >
                删除
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
