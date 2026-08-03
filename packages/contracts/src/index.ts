// 桶文件(barrel)：共享层的统一出口。只放前后端真正共享的数据契约
// (常量 / 类型 / DTO / 校验 schema)。环境变量校验是各包私有关注点，不放这里。
//
// 模板骨架目前只保留一个最小示例（APP_NAME），
// 新业务模块的共享契约按目录加入（如 src/todo/todo.schema.ts），并在此处导出。
export const APP_NAME = "FXPlanner-new";

// Project 模块共享契约
export * from './project';
