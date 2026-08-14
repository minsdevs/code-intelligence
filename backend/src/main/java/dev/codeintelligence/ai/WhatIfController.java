package dev.codeintelligence.ai;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class WhatIfController {

    private final WhatIfService whatIfService;

    public WhatIfController(WhatIfService whatIfService) {
        this.whatIfService = whatIfService;
    }

    @PostMapping("/api/projects/{projectId}/what-if")
    public WhatIfService.WhatIfView whatIf(
            @PathVariable long projectId,
            @RequestBody WhatIfService.WhatIfRequest body,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return whatIfService.simulate(projectId, user.userId(), body);
    }
}
