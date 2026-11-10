#import <AppKit/AppKit.h>

typedef void (^MenuAction)(void);
typedef void (^ResponseHandler)(NSDictionary *response, NSString *error);

@interface MemoMenu : NSObject <NSApplicationDelegate, NSMenuDelegate>
@property (nonatomic, strong) NSURL *address;
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, strong) NSStatusItem *statusItem;
@property (nonatomic, strong) NSTimer *timer;
@property (nonatomic, strong) NSDictionary *state;
@property (nonatomic, copy) NSString *feedback;
@property (nonatomic) BOOL fetching;
@property (nonatomic) BOOL working;
@end

@implementation MemoMenu

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    NSNumber *port = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"MemoPort"] ?: @4317;
    self.address = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%@", port]];
    self.session = [NSURLSession sessionWithConfiguration:[NSURLSessionConfiguration ephemeralSessionConfiguration]];
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    self.statusItem.autosaveName = @"Memo";
    self.statusItem.button.title = @"Memo";
    [self.statusItem.button setAccessibilityLabel:@"Memo"];
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Memo"];
    menu.autoenablesItems = NO;
    menu.delegate = self;
    self.statusItem.menu = menu;
    [self menuNeedsUpdate:menu];
    __weak MemoMenu *weakSelf = self;
    self.timer = [NSTimer scheduledTimerWithTimeInterval:15 repeats:YES block:^(__unused NSTimer *timer) {
        [weakSelf refresh:NO];
    }];
    [self refresh:NO];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    (void)notification;
    [self.timer invalidate];
    [self.session invalidateAndCancel];
}

- (void)request:(NSString *)path body:(NSDictionary *)body timeout:(NSTimeInterval)timeout done:(ResponseHandler)done {
    NSURL *url = [NSURL URLWithString:path relativeToURL:self.address];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url
        cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:timeout];
    if (body) {
        request.HTTPMethod = @"POST";
        request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
        [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
        [request setValue:self.address.absoluteString forHTTPHeaderField:@"Origin"];
        [request setValue:@"1" forHTTPHeaderField:@"X-Memo-Request"];
    }
    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        id json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        NSDictionary *result = [json isKindOfClass:[NSDictionary class]] ? json : nil;
        NSString *message = nil;
        if (error || status < 200 || status >= 300 || !result) {
            message = result[@"error"] ?: error.localizedDescription ?: @"Memo 服务返回了意外响应。";
            result = nil;
        }
        dispatch_async(dispatch_get_main_queue(), ^{ done(result, message); });
    }];
    [task resume];
}

- (NSArray *)tasks {
    return [self.state[@"items"] filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *item, __unused NSDictionary *bindings) {
        return [item[@"kind"] isEqual:@"task"] && ![item[@"done"] boolValue];
    }]];
}

- (void)refresh:(BOOL)showResult {
    if (self.fetching) return;
    self.fetching = YES;
    [self request:@"/api/state" body:nil timeout:3 done:^(NSDictionary *response, __unused NSString *error) {
        self.fetching = NO;
        self.state = [response[@"items"] isKindOfClass:[NSArray class]] && [response[@"proposals"] isKindOfClass:[NSArray class]]
            ? response : nil;
        if (showResult) self.feedback = self.state ? @"已刷新。" : @"请确认 Python 服务已启动。";
        NSUInteger pending = [self.state[@"proposals"] count];
        self.statusItem.button.title = pending ? [NSString stringWithFormat:@"Memo %lu", (unsigned long)pending] : @"Memo";
        self.statusItem.button.toolTip = self.state
            ? [NSString stringWithFormat:@"Memo · %lu 项待办 · %lu 条待确认", (unsigned long)self.tasks.count, (unsigned long)pending]
            : @"Memo · 服务未连接";
    }];
}

- (void)perform:(NSString *)path body:(NSDictionary *)body timeout:(NSTimeInterval)timeout success:(NSString *)success {
    if (self.working) return;
    self.working = YES;
    self.feedback = nil;
    [self request:path body:body timeout:timeout done:^(__unused NSDictionary *response, NSString *error) {
        self.working = NO;
        self.feedback = error ?: success;
        [self refresh:NO];
    }];
}

- (NSString *)shorten:(NSString *)text {
    NSString *line = [[text componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]] componentsJoinedByString:@" "];
    if (line.length <= 55) return line;
    NSRange prefix = [line rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, 54)];
    return [[line substringWithRange:prefix] stringByAppendingString:@"…"];
}

- (NSString *)taskLabel:(NSDictionary *)task {
    NSString *title = [self shorten:task[@"text"]];
    NSString *due = task[@"due"];
    return [due isKindOfClass:[NSString class]] ? [NSString stringWithFormat:@"%@ · %@", title, due] : title;
}

- (void)runAction:(NSMenuItem *)sender {
    MenuAction action = sender.representedObject;
    if (action) action();
}

- (void)add:(NSString *)title to:(NSMenu *)menu action:(MenuAction)action {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action ? @selector(runAction:) : NULL keyEquivalent:@""];
    item.target = self;
    item.representedObject = [action copy];
    item.enabled = action != nil;
    [menu addItem:item];
}

- (NSMenu *)submenu:(NSString *)title in:(NSMenu *)parent {
    NSMenu *child = [[NSMenu alloc] initWithTitle:title];
    child.autoenablesItems = NO;
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:NULL keyEquivalent:@""];
    item.submenu = child;
    [parent addItem:item];
    return child;
}

- (void)addTasks:(NSArray *)tasks to:(NSMenu *)menu {
    NSString *title = [NSString stringWithFormat:@"%lu 项进行中的待办", (unsigned long)tasks.count];
    if (!tasks.count) {
        [self add:title to:menu action:nil];
        return;
    }
    NSMenu *list = [self submenu:title in:menu];
    for (NSDictionary *task in [tasks subarrayWithRange:NSMakeRange(0, MIN(12, tasks.count))]) {
        [self add:[self taskLabel:task] to:list action:nil];
    }
    if (tasks.count > 12) [self add:@"其余待办见网页" to:list action:nil];
}

- (void)addProposals:(NSArray *)proposals tasks:(NSArray *)tasks to:(NSMenu *)menu {
    NSString *title = [NSString stringWithFormat:@"%lu 条待确认", (unsigned long)proposals.count];
    if (!proposals.count) {
        [self add:title to:menu action:nil];
        return;
    }
    NSMenu *list = [self submenu:title in:menu];
    __weak MemoMenu *weakSelf = self;
    for (NSDictionary *proposal in [proposals subarrayWithRange:NSMakeRange(0, MIN(12, proposals.count))]) {
        NSString *kind = proposal[@"kind"];
        BOOL completion = [kind isEqual:@"complete"];
        NSString *label = completion ? @"完成" : ([kind isEqual:@"task"] ? @"新增待办" : @"新增笔记");
        NSMenu *choices = [self submenu:[NSString stringWithFormat:@"%@ · %@", label, [self shorten:proposal[@"text"]]] in:list];
        NSString *endpoint = [@"/api/proposals/" stringByAppendingString:proposal[@"id"]];
        if (!self.working && completion) {
            for (NSString *candidate in proposal[@"candidates"]) {
                for (NSDictionary *task in tasks) {
                    if (![task[@"id"] isEqual:candidate]) continue;
                    [self add:[NSString stringWithFormat:@"确认完成「%@」", [self taskLabel:task]] to:choices action:^{
                        [weakSelf perform:endpoint body:@{@"action": @"accept", @"candidate": candidate} timeout:10 success:@"待办已完成。"];
                    }];
                    break;
                }
            }
        } else if (!self.working) {
            [self add:@"确认新增" to:choices action:^{
                [weakSelf perform:endpoint body:@{@"action": @"accept"} timeout:10 success:@"记录已保存。"];
            }];
        }
        [self add:@"在网页查看来源" to:choices action:^{
            NSURL *url = [NSURL URLWithString:@"/#inbox" relativeToURL:weakSelf.address];
            if (url) [[NSWorkspace sharedWorkspace] openURL:url];
        }];
    }
    if (proposals.count > 12) [self add:@"其余建议见网页" to:list action:nil];
}

- (void)menuNeedsUpdate:(NSMenu *)menu {
    [menu removeAllItems];
    [self add:self.state ? @"Memo · 本机服务已连接" : @"Memo · 服务未连接" to:menu action:nil];
    NSInteger waiting = [self.state[@"waiting"] integerValue];
    if (self.state) {
        NSArray *tasks = self.tasks;
        [self addTasks:tasks to:menu];
        [self addProposals:self.state[@"proposals"] tasks:tasks to:menu];
        if (waiting > 0) [self add:[NSString stringWithFormat:@"%ld 条 Codex 内容待处理", (long)waiting] to:menu action:nil];
    }
    if (self.feedback) [self add:[self shorten:self.feedback] to:menu action:nil];
    [menu addItem:[NSMenuItem separatorItem]];
    __weak MemoMenu *weakSelf = self;
    [self add:@"打开 Memo 网页" to:menu action:^{
        NSURL *url = weakSelf.address;
        if (url) [[NSWorkspace sharedWorkspace] openURL:url];
    }];
    [self add:@"刷新" to:menu action:^{ [weakSelf refresh:YES]; }];
    if (self.working || [self.state[@"summarizing"] boolValue]) {
        [self add:@"正在处理…" to:menu action:nil];
    } else if (waiting > 0 && [self.state[@"configured"] boolValue]) {
        [self add:@"立即汇总 Codex" to:menu action:^{
            [weakSelf perform:@"/api/summary" body:@{} timeout:300 success:@"汇总完成。"];
        }];
    }
    [menu addItem:[NSMenuItem separatorItem]];
    [self add:@"退出菜单栏客户端" to:menu action:^{ [NSApp terminate:nil]; }];
}

@end

int main(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        __attribute__((objc_precise_lifetime)) MemoMenu *delegate = [[MemoMenu alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
