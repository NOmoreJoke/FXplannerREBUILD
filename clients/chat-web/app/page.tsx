export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">FXPlanner-new</h1>
        <p className="text-gray-600 mb-8">全栈骨架已就绪，开始构建你的应用</p>
        <div className="flex gap-4 justify-center">
          <a href="/login" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
            登录
          </a>
          <a href="/register" className="px-4 py-2 border border-gray-300 hover:border-gray-400 rounded-lg transition-colors">
            注册
          </a>
        </div>
      </div>
    </main>
  );
}
