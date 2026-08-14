package dev.codeintelligence.search;

import dev.codeintelligence.common.security.AuthenticatedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class SearchController {

    private final SearchService searchService;

    public SearchController(SearchService searchService) {
        this.searchService = searchService;
    }

    @GetMapping("/api/search")
    public SearchService.SearchResponse search(
            @RequestParam String q,
            @RequestParam(required = false) Long projectId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return searchService.search(user.userId(), projectId, q);
    }
}
