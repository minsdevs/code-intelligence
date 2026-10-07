import { TodoItem } from "../components/TodoItem";

export function TodosPage() {
  fetch("/api/todos");
  return (
    <div>
      <h1>Todos</h1>
      <TodoItem title="sample" />
    </div>
  );
}
