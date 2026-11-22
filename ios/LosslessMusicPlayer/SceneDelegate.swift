import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let win = UIWindow(windowScene: windowScene)
        win.backgroundColor = UIColor(red: 1.0, green: 0.973, blue: 0.957, alpha: 1.0)
        win.rootViewController = ViewController()
        win.makeKeyAndVisible()
        self.window = win
    }
}
