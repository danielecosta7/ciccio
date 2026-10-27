// Notifiche del Mac con UNUserNotificationCenter: titolo, testo, clic e, per i permessi, due pulsanti.
// Le chiama notify.rs; i clic tornano a Rust con il callback (azione, userInfo in JSON).
// I pulsanti non portano l'app in primo piano: la risposta parte verso Ciccio e basta.

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

typedef void (*ciccio_action_cb)(const char *action, const char *user_info_json);

static ciccio_action_cb g_cb = NULL;
static NSMutableDictionary<NSString *, UNNotificationCategory *> *g_categories = nil;

static BOOL available(void) {
    // Fuori da un .app (cargo run) il centro notifiche fa crashare il processo.
    return [[NSBundle mainBundle] bundleIdentifier] != nil && [[[NSBundle mainBundle] bundlePath] hasSuffix:@".app"];
}

@interface CiccioNotifyDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation CiccioNotifyDelegate
// Anche con la finestra davanti la notifica si vede: l'avviso può essere di un'altra chat.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    NSString *action = response.actionIdentifier;
    if ([action isEqualToString:UNNotificationDefaultActionIdentifier]) action = @"open";
    else if ([action isEqualToString:UNNotificationDismissActionIdentifier]) action = @"dismiss";
    NSDictionary *info = response.notification.request.content.userInfo ?: @{};
    NSData *json = [NSJSONSerialization dataWithJSONObject:info options:0 error:nil];
    NSString *s = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"{}";
    if (g_cb) g_cb(action.UTF8String, s.UTF8String);
    completionHandler();
}
@end

static CiccioNotifyDelegate *g_delegate = nil;

void ciccio_notify_setup(ciccio_action_cb cb) {
    if (!available()) return;
    g_cb = cb;
    g_categories = [NSMutableDictionary dictionary];
    g_delegate = [CiccioNotifyDelegate new];
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    center.delegate = g_delegate;
    [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                          completionHandler:^(BOOL granted, NSError *error) {}];
}

/** Categoria con i due pulsanti: una per coppia di etichette (Consenti/Rifiuta, Sì/No…). */
static NSString *categoryFor(NSString *allow, NSString *deny) {
    NSString *ident = [NSString stringWithFormat:@"ciccio.%lu", (unsigned long)[[NSString stringWithFormat:@"%@\n%@", allow, deny] hash]];
    @synchronized (g_categories) {
        if (!g_categories[ident]) {
            UNNotificationAction *a = [UNNotificationAction actionWithIdentifier:@"allow" title:allow options:UNNotificationActionOptionNone];
            UNNotificationAction *d = [UNNotificationAction actionWithIdentifier:@"deny" title:deny options:UNNotificationActionOptionNone];
            g_categories[ident] = [UNNotificationCategory categoryWithIdentifier:ident actions:@[a, d] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone];
            [[UNUserNotificationCenter currentNotificationCenter] setNotificationCategories:[NSSet setWithArray:g_categories.allValues]];
        }
    }
    return ident;
}

static NSString *str(const char *s) { return s ? [NSString stringWithUTF8String:s] : nil; }

/** allow/deny NULL: notifica con il solo clic. user_info_json torna uguale al clic. */
void ciccio_notify_show(const char *ident, const char *title, const char *body, const char *allow, const char *deny, const char *user_info_json) {
    if (!available()) return;
    UNMutableNotificationContent *c = [UNMutableNotificationContent new];
    c.title = str(title) ?: @"Ciccio";
    c.body = str(body) ?: @"";
    c.sound = [UNNotificationSound defaultSound];
    NSData *data = [str(user_info_json) ?: @"{}" dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *info = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if ([info isKindOfClass:[NSDictionary class]]) c.userInfo = info;
    if (allow && deny) c.categoryIdentifier = categoryFor(str(allow), str(deny));
    UNNotificationRequest *req = [UNNotificationRequest requestWithIdentifier:str(ident) content:c trigger:nil];
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    // Le categorie appena registrate valgono solo dopo che il centro le ha lette: senza questo giro
    // la prima notifica di una coppia nuova arriverebbe senza pulsanti.
    [center getNotificationCategoriesWithCompletionHandler:^(NSSet<UNNotificationCategory *> *categories) {
        [center addNotificationRequest:req withCompletionHandler:nil];
    }];
}

void ciccio_notify_remove(const char *ident) {
    if (!available() || !ident) return;
    NSString *i = str(ident);
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    [center removeDeliveredNotificationsWithIdentifiers:@[i]];
    [center removePendingNotificationRequestsWithIdentifiers:@[i]];
}
