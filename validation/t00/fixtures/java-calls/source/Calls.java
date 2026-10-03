package demo;
interface Action { void run(); }
class FirstAction implements Action { public void run() {} }
class SecondAction implements Action { public void run() {} }
class Calls {
  static int twice(int value) { return value * 2; }
  static int direct() { return twice(2); }
  static void indirect(Action action) { action.run(); }
  static void dynamic(String name) throws Exception { Class.forName(name); }
}
