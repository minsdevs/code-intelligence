FROM eclipse-temurin:21-jdk AS build
WORKDIR /app
COPY . .

FROM eclipse-temurin:21-jre
COPY --from=build /app/app.jar /app/app.jar
CMD ["java", "-jar", "/app/app.jar"]
