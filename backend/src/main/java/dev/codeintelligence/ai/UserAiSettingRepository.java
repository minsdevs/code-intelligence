package dev.codeintelligence.ai;

import java.util.Optional;
import org.springframework.data.repository.CrudRepository;

public interface UserAiSettingRepository extends CrudRepository<UserAiSetting, Long> {

    Optional<UserAiSetting> findByUserId(long userId);
}
